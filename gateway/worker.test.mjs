import { describe, expect, test } from 'bun:test';
import { createGateway, MAX_REPLAY_BYTES, RETRY_BUDGET_MS } from './worker.mjs';

const env = { PREVIEW_URL: 'https://preview.example/', PREVIEW_TOKEN: 'preview-secret' };
function harness(respond) {
  const calls = [];
  const waits = [];
  let now = 0;
  const worker = createGateway({
    clock: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return respond(calls.length, options, () => now, (ms) => { now += ms; });
    },
  });
  return { worker, calls, waits, now: () => now };
}
function request(options = {}) { return new Request('https://remote.example:8443/api/send?q=one%2Ftwo', options); }

describe('gateway headers and routing', () => {
  test('separates preview and application credentials, strips spoofed and hop-by-hop headers', async () => {
    const h = harness(() => new Response('ok', { status: 201, headers: { 'set-cookie': 'session=abc' } }));
    const result = await h.worker.fetch(request({
      method: 'POST', body: 'payload', headers: {
        authorization: 'Bearer app-token', 'x-remote-agent-authorization': 'Bearer spoof',
        'x-remote-agent-host': 'evil.example', 'x-remote-agent-extra': 'evil',
        'x-remote-agent-client-ip': 'attacker', 'cf-connecting-ip': '203.0.113.10',
        forwarded: 'for=attacker;proto=http', 'x-forwarded-for': 'attacker',
        'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'x-real-ip': 'attacker',
        connection: 'keep-alive, x-drop', 'x-drop': 'gone', 'keep-alive': 'timeout=10',
        'proxy-authorization': 'Basic secret', 'transfer-encoding': 'chunked',
        cookie: 'session=old', origin: 'https://remote.example:8443',
      },
    }), env);
    const call = h.calls[0];
    expect(call.url).toBe('https://preview.example/api/send?q=one%2Ftwo');
    expect(call.method).toBe('POST');
    expect(new TextDecoder().decode(call.body)).toBe('payload');
    expect(call.redirect).toBe('manual');
    expect(call.headers.get('authorization')).toBe('Bearer preview-secret');
    expect(call.headers.get('x-remote-agent-authorization')).toBe('Bearer app-token');
    expect(call.headers.get('x-remote-agent-host')).toBe('remote.example:8443');
    expect(call.headers.get('x-remote-agent-client-ip')).toBe('203.0.113.10');
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) expect(call.headers.has(name)).toBe(false);
    expect(call.headers.get('cookie')).toBe('session=old');
    expect(call.headers.get('origin')).toBe('https://remote.example:8443');
    for (const name of ['x-remote-agent-extra', 'x-drop', 'connection', 'keep-alive', 'proxy-authorization', 'transfer-encoding']) {
      expect(call.headers.has(name)).toBe(false);
    }
    expect(result.status).toBe(201);
    expect(result.headers.get('set-cookie')).toBe('session=abc');
    expect(await result.text()).toBe('ok');
  });

  test('strips response hop-by-hop headers while preserving application headers', async () => {
    const h = harness(() => new Response('ok', { headers: {
      connection: 'keep-alive, x-drop', 'x-drop': 'secret', 'keep-alive': 'timeout=5',
      'proxy-authenticate': 'Basic realm=preview', 'x-app': 'preserved',
    } }));
    const response = await h.worker.fetch(request(), env);
    for (const name of ['connection', 'x-drop', 'keep-alive', 'proxy-authenticate']) {
      expect(response.headers.has(name)).toBe(false);
    }
    expect(response.headers.get('x-app')).toBe('preserved');
    expect(await response.text()).toBe('ok');
  });

  test('double-slash paths cannot change the upstream host', async () => {
    const h = harness(() => new Response('ok'));
    await h.worker.fetch(new Request('https://remote.example//evil.example/path?x=1'), env);
    expect(h.calls[0].url).toBe('https://preview.example//evil.example/path?x=1');
  });

  test('absent application auth strips spoofed tunneled auth', async () => {
    const h = harness(() => new Response('ok'));
    await h.worker.fetch(request({ headers: { 'x-remote-agent-authorization': 'Bearer spoof', 'x-remote-agent-client-ip': 'attacker' } }), env);
    expect(h.calls[0].headers.has('x-remote-agent-client-ip')).toBe(false);
    expect(h.calls[0].headers.has('x-remote-agent-authorization')).toBe(false);
    expect(h.calls[0].headers.get('authorization')).toBe('Bearer preview-secret');
  });

  test('rejects invalid bindings without fetching or disclosing secrets', async () => {
    const h = harness(() => { throw new Error('must not fetch'); });
    for (const bindings of [{}, { ...env, PREVIEW_URL: 'ftp://preview.example' }, { ...env, PREVIEW_TOKEN: '' }, { ...env, PREVIEW_URL: 'https://user:secret@preview.example' }]) {
      const result = await h.worker.fetch(request(), bindings);
      expect(result.status).toBe(503);
      expect(await result.text()).toBe('Gateway unavailable');
    }
    expect(h.calls.length).toBe(0);
  });

  test('network failures are sanitized and never retried', async () => {
    const h = harness(() => { throw new Error('preview-secret'); });
    const response = await h.worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Bad Gateway');
    expect(h.calls.length).toBe(1);
    expect(h.waits).toEqual([]);
  });
});

describe('gateway bounded replay', () => {
  test('replays small idempotent bodies after 502 with exponential backoff', async () => {
    const h = harness((attempt) => new Response(attempt < 4 ? 'warming up' : 'ready', { status: attempt < 4 ? 502 : 200 }));
    const response = await h.worker.fetch(request({ method: 'PUT', body: 'same bytes' }), env);
    expect(await response.text()).toBe('ready');
    expect(h.waits).toEqual([250, 500, 1000]);
    expect(h.calls.map((call) => new TextDecoder().decode(call.body))).toEqual(Array(4).fill('same bytes'));
  });

  test('non-idempotent POST and PATCH are never replayed even with small bodies', async () => {
    for (const method of ['POST', 'PATCH']) {
      const h = harness(() => new Response('ambiguous failure', { status: 502 }));
      expect((await h.worker.fetch(request({ method, body: 'small' }), env)).status).toBe(502);
      expect(h.calls.length).toBe(1);
      expect(h.waits).toEqual([]);
    }
  });

  test('stops before the 45 second deadline even when every attempt returns 502', async () => {
    const h = harness(() => new Response('still asleep', { status: 502 }));
    const response = await h.worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(h.now()).toBeLessThanOrEqual(RETRY_BUDGET_MS);
    expect(h.calls.length).toBeGreaterThan(1);
    expect(h.calls.length).toBeLessThan(20);
    expect(Math.max(...h.waits)).toBe(5000);
  });

  test('fetch time counts against the deadline', async () => {
    const h = harness((_attempt, _options, _now, advance) => {
      advance(RETRY_BUDGET_MS);
      return new Response('late', { status: 502 });
    });
    expect((await h.worker.fetch(request(), env)).status).toBe(502);
    expect(h.calls.length).toBe(1);
    expect(h.waits).toEqual([]);
  });

  test('a stalled fetch is aborted at the remaining deadline', async () => {
    let ticks = 0;
    let aborted = false;
    const worker = createGateway({
      clock: () => ticks++ === 0 ? 0 : RETRY_BUDGET_MS - 1,
      fetch: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('preview-secret')); });
      }),
      sleep: async () => { throw new Error('must not sleep'); },
    });
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Bad Gateway');
    expect(aborted).toBe(true);
  });

  test('exactly 1 MiB can replay', async () => {
    const h = harness((attempt) => new Response('body', { status: attempt === 1 ? 502 : 200 }));
    const bytes = new Uint8Array(MAX_REPLAY_BYTES).fill(42);
    expect((await h.worker.fetch(request({ method: 'PUT', body: bytes }), env)).status).toBe(200);
    expect(h.calls.length).toBe(2);
    expect(h.calls[0].body).toEqual(bytes);
    expect(h.calls[1].body).toEqual(bytes);
  });

  test('streams larger bodies exactly once without losing buffered prefix or tail', async () => {
    const chunks = [new Uint8Array(MAX_REPLAY_BYTES).fill(1), new Uint8Array([2]), new Uint8Array([3, 4])];
    let index = 0;
    const body = new ReadableStream({ pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    } });
    let received;
    const h = harness(async (_attempt, options) => {
      expect(options.body).toBeInstanceOf(ReadableStream);
      received = new Uint8Array(await new Response(options.body).arrayBuffer());
      return new Response('no replay', { status: 502 });
    });
    const response = await h.worker.fetch(request({ method: 'PUT', body, duplex: 'half' }), env);
    expect(response.status).toBe(502);
    expect(h.calls.length).toBe(1);
    expect(received.byteLength).toBe(MAX_REPLAY_BYTES + 3);
    expect(received[0]).toBe(1);
    expect([...received.slice(-4)]).toEqual([1, 2, 3, 4]);
  });

  test('non-502 errors and redirects are returned without replay', async () => {
    for (const status of [301, 401, 403, 500, 503, 504]) {
      const h = harness(() => new Response('response', { status }));
      expect((await h.worker.fetch(request(), env)).status).toBe(status);
      expect(h.calls.length).toBe(1);
    }
  });

  test('aborted clients do not initiate fetches', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(() => new Response('must not fetch'));
    expect((await h.worker.fetch(request({ signal: controller.signal }), env)).status).toBe(502);
    expect(h.calls.length).toBe(0);
  });
});

describe('gateway WebSocket', () => {
  test('retries only before 101 and returns the original WebSocket response', async () => {
    // Bun's Response rejects 101; the Worker platform supplies this handle.
    const upgraded = { status: 101, webSocket: { platformHandle: true } };
    const h = harness((attempt) => attempt === 1 ? new Response('warming', { status: 502 }) : upgraded);
    const result = await h.worker.fetch(request({ headers: {
      upgrade: 'websocket', connection: 'Upgrade, x-drop', 'x-drop': 'evil',
      'sec-websocket-key': 'key', 'sec-websocket-protocol': 'app', authorization: 'Bearer app-token',
    } }), env);
    expect(result).toBe(upgraded);
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].headers.get('upgrade')).toBe('websocket');
    expect(h.calls[1].headers.get('connection')).toBe('Upgrade');
    expect(h.calls[1].headers.has('x-drop')).toBe(false);
    expect(h.calls[1].headers.get('sec-websocket-key')).toBe('key');
    expect(h.calls[1].headers.get('sec-websocket-protocol')).toBe('app');
    expect(h.calls[1].headers.get('x-remote-agent-authorization')).toBe('Bearer app-token');
  });
});
