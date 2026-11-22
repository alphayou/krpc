# Examples

Minimal runnable end-to-end examples for `krpc` (run from the repo root with Bun):

- `bun run examples/http.ts` — HTTP server & client (`createHttpHandler`, `httpTransport`, typed errors, `batch`, `createProxy`, `notify`)
- `bun run examples/ws-peer.ts` — Full-duplex WebSocket peer (`createBunHandler`, `wsTransport`, `ctx.after`, `ctx.notify`, `server.notify`, `peer.on`)
- `bun run examples/stream.ts` — Full-duplex Web Streams peer with `content-length` framing (`streamTransport`, `createPeer`)
- `bun run examples/stdio.ts` — Parent/child subprocess peer over OS stdio pipes (`stdioTransport`, `createPeer`, `ctx.notify`, `peer.on`)
- `bun run examples/port.ts` — Full-duplex `MessageChannel` / Web Worker peer (`portTransport`, `createPeer`, `ctx.notify`, `peer.on`)
