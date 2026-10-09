import http from 'node:http';
import { pathToFileURL } from 'node:url';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function cleanHeaders(source) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(source.connection ?? '').split(',')) {
    blocked.add(name.trim().toLowerCase());
  }
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (value !== undefined && !blocked.has(lower) && !lower.startsWith('x-remote-agent-')) {
      headers[lower] = value;
    }
  }
  return headers;
}

function websocketHeaders(source) {
  return { ...cleanHeaders(source), connection: 'Upgrade', upgrade: 'websocket' };
}

function requestHeaders(request) {
  const headers = cleanHeaders(request.headers);
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip']) delete headers[name];
  const clientIP = request.headers['x-remote-agent-client-ip'];
  if (typeof clientIP === 'string' && clientIP) headers['x-forwarded-for'] = clientIP;
  // Never let preview credentials become application credentials.
  delete headers.authorization;
  const auth = request.headers['x-remote-agent-authorization'];
  if (typeof auth === 'string' && auth) headers.authorization = auth;
  const host = request.headers['x-remote-agent-host'];
  if (typeof host === 'string' && host) {
    headers.host = host;
    headers['x-forwarded-host'] = host;
  } else {
    delete headers['x-forwarded-host'];
  }
  headers['x-forwarded-proto'] = 'https';
  return headers;
}

function writeSocketResponse(socket, status, message, headers) {
  let head = `HTTP/1.1 ${status} ${message}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      head += `${name}: ${item}\r\n`;
    }
  }
  socket.write(`${head}\r\n`);
}

/** Return an unstarted Node HTTP server; caller owns listen/close. */
export function createRelay({ upstreamHost = '127.0.0.1', upstreamPort = 3773 } = {}) {
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: upstreamHost, port: upstreamPort, method: request.method,
      path: request.url, headers: requestHeaders(request),
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, cleanHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      incoming.on('aborted', () => response.destroy());
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end('Bad Gateway');
      }
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on('upgrade', (request, socket, head) => {
    if (String(request.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let peer;
    let upgraded = false;
    const upstream = http.request({
      hostname: upstreamHost, port: upstreamPort, method: request.method,
      path: request.url, headers: websocketHeaders(requestHeaders(request)),
    });
    const fail = () => {
      if (upgraded) socket.destroy();
      else if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    };
    socket.on('error', () => { upstream.destroy(); peer?.destroy(); });
    socket.on('close', () => { upstream.destroy(); peer?.destroy(); });
    upstream.on('error', fail);
    upstream.on('upgrade', (incoming, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      if (socket.destroyed) { peer.destroy(); return; }
      upgraded = true;
      writeSocketResponse(socket, incoming.statusCode ?? 101, incoming.statusMessage ?? 'Switching Protocols',
        websocketHeaders(incoming.headers));
      // Bytes already read by either HTTP parser must precede piped bytes.
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy());
      peer.on('close', () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on('response', (incoming) => {
      writeSocketResponse(socket, incoming.statusCode ?? 502, incoming.statusMessage ?? 'Bad Gateway', {
        ...cleanHeaders(incoming.headers), connection: 'close',
      });
      incoming.on('error', () => socket.destroy());
      incoming.on('aborted', () => socket.destroy());
      incoming.pipe(socket);
    });
    upstream.end();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRelay().listen(3774, '0.0.0.0');
}
