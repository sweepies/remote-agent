export const MAX_REPLAY_BYTES = 1024 * 1024;
export const RETRY_BUDGET_MS = 45_000;
// A reproducible body alone does not make a mutation safe to repeat.
const REPLAY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);
const HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];

function upstreamHeaders(request, token, host) {
  const headers = new Headers(request.headers);
  const auth = headers.get('authorization');
  const websocket = headers.get('upgrade')?.toLowerCase() === 'websocket';
  const connectionNames = (headers.get('connection') ?? '').split(',');
  for (const name of [...HOP_HEADERS, ...connectionNames]) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-remote-agent-')) headers.delete(name);
  }
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) headers.delete(name);
  // Cloudflare supplies this header at the edge; never accept a client's dedicated header.
  const clientIP = request.headers.get('cf-connecting-ip');
  if (clientIP) headers.set('x-remote-agent-client-ip', clientIP);
  // Preserve application credentials separately from preview authentication.
  if (auth !== null) headers.set('x-remote-agent-authorization', auth);
  headers.set('x-remote-agent-host', host);
  headers.set('authorization', `Bearer ${token}`);
  headers.delete('host');
  if (websocket) {
    headers.set('upgrade', 'websocket');
    headers.set('connection', 'Upgrade');
  }
  return headers;
}

/** Buffer at most 1 MiB for replay; larger bodies keep streaming, once only. */
async function prepareBody(body) {
  if (!body) return { replayable: true, body: undefined };
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock();
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { replayable: true, body: bytes };
      }
      chunks.push(value);
      length += value.byteLength;
      if (length > MAX_REPLAY_BYTES) {
        return {
          replayable: false,
          body: new ReadableStream({
            async pull(controller) {
              if (chunks.length) { controller.enqueue(chunks.shift()); return; }
              try {
                const next = await reader.read();
                if (next.done) { reader.releaseLock(); controller.close(); }
                else controller.enqueue(next.value);
              } catch (error) { controller.error(error); }
            },
            async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
          }),
        };
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  }
}

function unavailable() {
  return new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } });
}

function downstreamResponse(response) {
  // Reconstructing a 101 loses the platform WebSocket handle.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  const connectionNames = (headers.get('connection') ?? '').split(',');
  for (const name of [...HOP_HEADERS, ...connectionNames]) {
    if (name.trim()) headers.delete(name.trim());
  }
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

/** Dependencies are injectable; no network, sleeping, or wall clock needed in tests. */
export function createGateway({
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = Date.now,
} = {}) {
  return {
    async fetch(request, env) {
      let target;
      try {
        target = new URL(env.PREVIEW_URL);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
            typeof env.PREVIEW_TOKEN !== 'string' || !env.PREVIEW_TOKEN || /[\r\n]/.test(env.PREVIEW_TOKEN)) {
          throw new Error('Invalid configuration');
        }
      } catch {
        return new Response('Gateway unavailable', { status: 503 });
      }
      const deadline = clock() + RETRY_BUDGET_MS;
      try {
        const original = new URL(request.url);
        target.pathname = original.pathname;
        target.search = original.search;
        target.hash = '';
        const headers = upstreamHeaders(request, env.PREVIEW_TOKEN, original.host);
        const prepared = await prepareBody(request.body);
        let delay = 250;
        while (true) {
          const remaining = deadline - clock();
          if (remaining <= 0 || request.signal.aborted) return unavailable();
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, remaining);
          let response;
          try {
            const options = {
              method: request.method, headers: new Headers(headers), body: prepared.body,
              redirect: 'manual', signal: controller.signal,
            };
            if (prepared.body instanceof ReadableStream) options.duplex = 'half';
            response = await fetchImpl(target.toString(), options);
          } finally {
            clearTimeout(timer);
            request.signal.removeEventListener('abort', abort);
          }
          // Return 101 untouched, including the platform's WebSocket handle.
          if (response.status !== 502 || !prepared.replayable || !REPLAY_METHODS.has(request.method)) {
            return downstreamResponse(response);
          }
          if (deadline - clock() <= delay || request.signal.aborted) return downstreamResponse(response);
          // Release a failed attempt before retrying; never expose/log its credentials.
          response.body?.cancel().catch(() => {});
          await sleep(delay);
          delay = Math.min(delay * 2, 5_000);
        }
      } catch {
        // Network errors are not retried: only explicit preview 502 responses are.
        return unavailable();
      }
    },
  };
}

export default createGateway();
