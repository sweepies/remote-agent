# Preview-to-application relay

`server.mjs` is a zero-dependency Node ESM HTTP/WebSocket proxy. Direct execution
(`node relay/server.mjs`) listens on `0.0.0.0:3774`, forwarding to
`127.0.0.1:3773`. Importing it does not start a server.

```js
import { createRelay } from './relay/server.mjs';
const server = createRelay({ upstreamHost: '127.0.0.1', upstreamPort: 3773 });
// Caller owns server.listen(...) and server.close(...).
```

## Gateway contract

- `X-Remote-Agent-Authorization` becomes the application `Authorization` header.
  When absent/empty, incoming authorization is removed entirely, including
  Upstash Basic and preview Bearer credentials.
- `X-Remote-Agent-Host` becomes both `Host` and `X-Forwarded-Host`.
  `X-Forwarded-Proto` is always `https`. Without a tunneled host, incoming Host
  remains, but incoming `X-Forwarded-Host` is discarded.
- All `x-remote-agent-*` headers and hop-by-hop headers (including names nominated
  by `Connection`) are stripped. WebSocket handshakes restore only
  `Upgrade: websocket` and `Connection: Upgrade`.
- HTTP status, cookies, path/query and body are forwarded. WebSocket handshakes
  preserve handshake headers and parser head bytes in both directions before
  piping later bytes. Rejected upgrades remain HTTP responses.
- Upstream connection failures return generic 502s; failures after response or
  upgrade close the connection. Disconnects tear down the corresponding peer.
  No credentials, request headers or error objects are logged.

This relay trusts the custom headers. Its network exposure must be restricted to
the intended authenticated preview path; it is not a standalone authentication
boundary. The Worker strips client spoofing before setting these headers.

Offline tests: `bun test relay/` (ephemeral loopback servers only).
