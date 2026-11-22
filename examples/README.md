# Examples

Minimal runnable end-to-end examples for `krpc` (run from the repo root with Bun):

- `bun run examples/http.ts` — HTTP server & client (`createHttpHandler`, `httpTransport`, typed errors, `batch`, `createProxy`, `notify`)
- `bun run examples/ws-peer.ts` — Full-duplex WebSocket peer (`createWsServerTransport`, `wsTransport`, `ctx.notify`, out-of-band `peer.notify`, `peer.on`)
- `bun run examples/stream.ts` — Full-duplex Web Streams peer with `content-length` framing (`streamTransport`, `createPeer`)
