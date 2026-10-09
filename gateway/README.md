# Worker preview gateway

`worker.mjs` exports a Worker-compatible default `{ fetch(request, env) }` and
`createGateway({ fetch, sleep, clock })` for offline testing. It has no dependencies.
No deployment, package pins or service configuration are included here.

## Bindings and routing

- `PREVIEW_URL`: HTTP(S) preview origin exposing the relay's port 3774. URL-embedded
  credentials are rejected. Its path/query are replaced with the client's
  path/query; redirects are returned, never followed with credentials.
- `PREVIEW_TOKEN`: nonempty preview bearer secret. The outgoing preview request
  uses `Authorization: Bearer <PREVIEW_TOKEN>`.
- The original client Authorization, when present, is carried in
  `X-Remote-Agent-Authorization`. `X-Remote-Agent-Host` is the client URL's host,
  including a nondefault port. All client `x-remote-agent-*` headers are removed
  before generating these values. Cookies and application handshake headers pass
  through normally.
- Request/response hop-by-hop headers, including names listed in `Connection`,
  are removed. WebSocket requests retain the required Upgrade/Connection pair;
  successful 101 responses are returned unchanged to preserve the platform's
  WebSocket handle.

## Warm-up retry contract

Only explicit upstream 502 responses are retried, with delays of 250 ms, 500 ms,
1 s, 2 s, 4 s, then 5 s maximum. The retry deadline is 45 seconds from request
processing, including fetch elapsed time. No retry is scheduled when its delay
would exhaust the deadline. Fetch attempts receive an AbortSignal with the
remaining budget; successful response streams/tunnels are not timed out afterward.
Network exceptions and all non-502 statuses are not retried.

Replay requires both an idempotent method (`GET`, `HEAD`, `OPTIONS`, `PUT`,
`DELETE`, `TRACE`) and a body at or below 1,048,576 bytes. Those bodies are buffered
for byte-for-byte replay. Non-idempotent POST/PATCH requests are sent once, even
with a small body: a 502 does not prove that application delivery never occurred.
Larger bodies retain their consumed prefix and stream through once, without
retry. WebSocket retries occur only before a successful 101.

Missing/invalid bindings yield a generic 503. Network/body failures yield a
generic 502; no secret-bearing errors or headers are logged.

## Test injection

`fetch(urlString, init)` returns a Response (or mocked 101 platform response).
`sleep(milliseconds)` returns a promise; `clock()` returns milliseconds. Mock
sleep should advance the mock clock. The real AbortSignal timer remains active
for stalled-fetch testing. The default export uses global fetch, setTimeout and
Date.now.

Run all offline proxy tests: `bun test relay/ gateway/`.
