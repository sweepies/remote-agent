import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import { createRelay } from './server.mjs';

const servers = [];
const sockets = new Set();
async function listen(server) {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
async function relayFor(upstream) {
  const upstreamPort = await listen(upstream);
  return listen(createRelay({ upstreamPort }));
}
function send(port, { method = 'GET', headers = {}, body = '', path = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}
function raw(port, packet, complete, onData) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    sockets.add(socket);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('socket test timed out')); }, 2000);
    const finish = () => { clearTimeout(timer); resolve(data); };
    socket.on('connect', () => socket.write(packet));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      onData?.(socket, data);
      if (complete?.(data)) { socket.destroy(); finish(); }
    });
    socket.on('end', finish);
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
const upgradeRequest = 'GET /ws?ticket=abc HTTP/1.1\r\nHost: preview.example\r\nUpgrade: websocket\r\nConnection: Upgrade, x-drop\r\nx-drop: secret\r\nX-Remote-Agent-Authorization: Bearer app-token\r\nX-Remote-Agent-Host: remote.example\r\nX-Remote-Agent-Spoof: evil\r\nX-Remote-Agent-Client-IP: 203.0.113.10\r\nForwarded: for=spoof\r\nX-Forwarded-For: spoof\r\nX-Forwarded-Host: spoof\r\nX-Forwarded-Proto: http\r\nX-Real-IP: spoof\r\n\r\n';

describe('relay HTTP', () => {
  test('restores application auth and external origin, strips transport/private headers, preserves payload', async () => {
    let received;
    const port = await relayFor(http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received = { headers: request.headers, method: request.method, url: request.url, body: Buffer.concat(chunks).toString() };
        response.writeHead(201, { 'set-cookie': ['a=1', 'b=2'], 'x-remote-agent-debug': 'private', connection: 'x-drop', 'x-drop': 'gone' });
        response.end('created');
      });
    }));
    const result = await send(port, {
      method: 'POST', path: '/api/send?q=one%2Ftwo', body: 'payload',
      headers: {
        authorization: 'Basic preview-secret', 'x-remote-agent-authorization': 'Bearer app-token',
        'x-remote-agent-host': 'remote.example:443', 'x-remote-agent-evil': 'spoof',
        'x-forwarded-host': 'evil', 'x-forwarded-proto': 'http', cookie: 'session=abc',
        forwarded: 'for=attacker', 'x-forwarded-for': 'attacker', 'x-real-ip': 'attacker',
        'cf-connecting-ip': 'preview-spoof', 'x-remote-agent-client-ip': '203.0.113.10',
        connection: 'keep-alive, x-drop', 'x-drop': 'gone', 'proxy-authorization': 'Basic secret',
      },
    });
    expect(received).toMatchObject({ method: 'POST', url: '/api/send?q=one%2Ftwo', body: 'payload' });
    expect(received.headers).toMatchObject({ authorization: 'Bearer app-token', host: 'remote.example:443', 'x-forwarded-host': 'remote.example:443', 'x-forwarded-proto': 'https', cookie: 'session=abc' });
    expect(Object.keys(received.headers).some((name) => name.startsWith('x-remote-agent-'))).toBe(false);
    expect(received.headers['x-forwarded-for']).toBe('203.0.113.10');
    for (const name of ['forwarded', 'x-real-ip', 'cf-connecting-ip']) expect(received.headers[name]).toBeUndefined();
    expect(received.headers['x-drop']).toBeUndefined();
    expect(received.headers['proxy-authorization']).toBeUndefined();
    expect(result).toMatchObject({ status: 201, body: 'created' });
    expect(result.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(result.headers['x-drop']).toBeUndefined();
    expect(result.headers['x-remote-agent-debug']).toBeUndefined();
  });

  test('absent tunneled auth never passes preview Basic or Bearer to application', async () => {
    const port = await relayFor(http.createServer((request, response) => response.end(JSON.stringify(request.headers))));
    for (const authorization of ['Basic preview-secret', 'Bearer preview-secret']) {
      const result = await send(port, { headers: { authorization, 'x-forwarded-host': 'spoof', 'x-forwarded-for': 'spoof', forwarded: 'for=spoof', 'x-real-ip': 'spoof' } });
      const headers = JSON.parse(result.body);
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-forwarded-host']).toBeUndefined();
      for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip']) expect(headers[name]).toBeUndefined();
      expect(headers['x-forwarded-proto']).toBe('https');
    }
  });

  test('connection failure yields a generic 502 without credentials', async () => {
    const unused = http.createServer();
    const upstreamPort = await listen(unused);
    await new Promise((resolve) => unused.close(resolve));
    servers.splice(servers.indexOf(unused), 1);
    const port = await listen(createRelay({ upstreamPort }));
    const result = await send(port, { headers: { authorization: 'Basic secret' } });
    expect(result.status).toBe(502);
    expect(result.body).toBe('Bad Gateway');
  });
});

describe('relay WebSocket', () => {
  test('forwards both parser heads, later bytes, and handshake headers', async () => {
    let headers;
    let received = '';
    const upstream = http.createServer();
    upstream.on('upgrade', (request, socket, head) => {
      headers = request.headers;
      received += head.toString();
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test-accept\r\n\r\nSERVER-HEAD');
      if (head.length) socket.write(head);
      socket.on('data', (chunk) => { received += chunk.toString(); socket.write(chunk); });
    });
    const port = await relayFor(upstream);
    let sentLater = false;
    const data = await raw(port, upgradeRequest + 'CLIENT-HEAD', (text) => text.includes('SERVER-HEAD') && text.includes('CLIENT-HEAD') && text.includes('LATER'),
      (socket, text) => {
        if (!sentLater && text.includes('SERVER-HEAD')) { sentLater = true; socket.write('LATER'); }
      });
    expect(data).toContain('101 Switching Protocols');
    expect(data).toContain('sec-websocket-accept: test-accept');
    expect(received).toBe('CLIENT-HEADLATER');
    expect(headers).toMatchObject({ authorization: 'Bearer app-token', host: 'remote.example', 'x-forwarded-proto': 'https', upgrade: 'websocket' });
    expect(headers['x-forwarded-for']).toBe('203.0.113.10');
    expect(headers['x-forwarded-host']).toBe('remote.example');
    expect(headers.forwarded).toBeUndefined();
    expect(headers['x-real-ip']).toBeUndefined();
    expect(headers['x-drop']).toBeUndefined();
    expect(Object.keys(headers).some((name) => name.startsWith('x-remote-agent-'))).toBe(false);
  });

  test('forwards an HTTP rejection instead of issuing a false 101', async () => {
    const upstream = http.createServer();
    upstream.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\n\r\ndenied'));
    const port = await relayFor(upstream);
    const data = await raw(port, upgradeRequest);
    expect(data).toContain('401 Unauthorized');
    expect(data.endsWith('denied')).toBe(true);
  });

  test('upstream disconnect after 101 closes the downstream tunnel', async () => {
    const upstream = http.createServer();
    upstream.on('upgrade', (_request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      setTimeout(() => socket.destroy(), 10);
    });
    const port = await relayFor(upstream);
    expect(await raw(port, upgradeRequest)).toContain('101 Switching Protocols');
  });

  test('upstream disconnect before upgrade returns 502', async () => {
    const upstream = http.createServer();
    upstream.on('upgrade', (_request, socket) => socket.destroy());
    const port = await relayFor(upstream);
    expect(await raw(port, upgradeRequest)).toContain('502 Bad Gateway');
  });
});
