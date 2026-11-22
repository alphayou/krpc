# Transports

`krpc` supports two transport models:

- **`ClientTransport`** — unidirectional request/response (used with `createClient`).
- **`DuplexTransport`** — bidirectional message stream (used with `createPeer`).

## Built-in Transports

| Entry Point   | Exports                                                                                                                 | Model           | Best For                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------- |
| `krpc`        | `createMemoryTransport`, `createMemoryDuplexPair`, `batchTransport`, `isDuplexTransport`                                | Client & Duplex | Unit tests, SSR, in-process calls, auto-batching  |
| `krpc/http`   | `httpTransport`, `createHttpHandler`                                                                                    | Client + Fetch  | `Bun.serve`, Cloudflare Workers, Hono, browsers   |
| `krpc/ws`     | `wsTransport`, `createWsServerTransport`, `createWsHandler`                                                             | Duplex          | Real-time apps, server push, bidirectional RPC    |
| `krpc/bun`    | `createBunHandler`                                                                                                      | HTTP + Duplex   | Unified HTTP + WebSocket `Bun.serve` endpoints    |
| `krpc/stream` | `streamTransport`, `encodeNdjsonFrame`, `createNdjsonDecoder`, `encodeContentLengthFrame`, `createContentLengthDecoder` | Duplex          | Web Streams, pipes, IPC, LSP-style framing        |
| `krpc/stdio`  | `stdioTransport`                                                                                                        | Duplex          | CLI servers (`stdin`/`stdout`), subprocess pipes  |
| `krpc/port`   | `portTransport`                                                                                                         | Duplex          | `MessageChannel`, Web Workers, `MessagePort` APIs |

## Memory (`krpc`)

Connect a client or peer directly to a server in memory without sockets or HTTP:

```ts
import {
  createClient,
  createMemoryDuplexPair,
  createMemoryTransport,
  createPeer,
  createServer,
} from 'krpc'

// Request/response (accepts optional `{ setupContext }` for per-call context)
const server = createServer(app)
const client = createClient<App>(
  createMemoryTransport(server, {
    setupContext(ctx) {
      ctx.set(Locale, 'en-US')
    },
  })
)

// Full-duplex (messages delivered asynchronously via microtasks)
const [serverTransport, clientTransport] = createMemoryDuplexPair()
const serverPeer = createPeer(serverTransport, app)
const clientPeer = createPeer<App>(clientTransport)
```

## Auto-Batching (`batchTransport` in `krpc`)

Wrap any `ClientTransport` with `batchTransport` to automatically coalesce concurrent `client.call` and `client.notify` invocations into a single JSON-RPC 2.0 batch array:

```ts
import { batchTransport, createClient } from 'krpc'
import { httpTransport } from 'krpc/http'

const client = createClient<App>(
  batchTransport(httpTransport('http://localhost:3000/rpc'), {
    windowMs: 0, // default: coalesce within current microtask; set > 0 for timer window
    maxBatchSize: 50, // default: flush eagerly once queue reaches 50 items
  })
)

// Sent as a single HTTP POST JSON-RPC batch request
const [a, b] = await Promise.all([
  client.call('math.add', { a: 1, b: 2 }),
  client.call('math.add', { a: 3, b: 4 }),
])
```

- **Single-item fast path**: If only one call is queued when flushing, it is sent as a single JSON-RPC object rather than a 1-element array.
- **No nested batches**: Explicit `client.batch(...)` arrays pass straight through to the inner transport immediately.
- **Per-call cancellation**: Aborting an `AbortSignal` before flush removes that call from the queue; aborting after flush rejects only that caller without disrupting sibling calls.

## HTTP (`krpc/http`)

Built on Web Standard `fetch`, `Request`, and `Response`.

### Client

```ts
import { createClient } from 'krpc'
import { httpTransport } from 'krpc/http'

const client = createClient<App>(
  httpTransport('http://localhost:3000/rpc', {
    // Static headers or a sync/async factory invoked per request
    headers: async () => ({
      authorization: `Bearer ${await getToken()}`,
    }),
    credentials: 'include',
  }),
  { timeout: 5_000 }
)
```

`httpTransport` sends `POST` requests with `Content-Type: application/json`, supports custom `fetch` and `credentials`, forwards `AbortSignal` to `fetch`, accepts `204 No Content` (or empty bodies) for Notifications, and throws `KrpcTransportError` (with `status`) on non-2xx responses or invalid JSON bodies.

### Server

`createHttpHandler` returns a standard `(req: Request) => Promise<Response>` function that works directly with `Bun.serve`, Cloudflare Workers, Deno, and Hono:

```ts
import { createServer } from 'krpc'
import { createHttpHandler } from 'krpc/http'

const server = createServer(app, { maxBatchSize: 50, batchConcurrency: 10 })
const rpcHandler = createHttpHandler(server, {
  maxBodySize: 1024 * 1024, // 1 MiB (default)
  setupContext(ctx, req) {
    ctx.set(Headers, req.headers)
  },
})

Bun.serve({
  routes: {
    '/rpc': {
      POST: (req) => rpcHandler(req),
    },
  },
})
```

### HTTP Status Code Mapping

| Condition                                            | HTTP Status                  | Body                                           |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| JSON-RPC success, error, or non-empty batch response | `200 OK`                     | JSON-RPC response payload (`application/json`) |
| Pure Notification or all-Notification batch          | `204 No Content`             | Empty                                          |
| Non-`POST` HTTP method                               | `405 Method Not Allowed`     | `'Method Not Allowed'` (`allow: POST`)         |
| Request body exceeds `maxBodySize`                   | `413 Payload Too Large`      | `'Payload Too Large'`                          |
| Missing or non-JSON `Content-Type` header            | `415 Unsupported Media Type` | `'Unsupported Media Type'`                     |

- **`maxBodySize`**: Measured incrementally on the incoming byte stream (and fast-rejected if `Content-Length` already exceeds the limit) so oversized bodies are cancelled immediately.
- **Cancellation**: `req.signal` is automatically forwarded to `ctx.signal`.
- **Context**: `setupContext(ctx, req)` runs before `onBefore` hooks to attach headers, cookies, or request metadata.
- **Background tasks (`waitUntil`)**: Pass `waitUntil` (e.g. Cloudflare Workers `executionCtx.waitUntil`) to keep `ctx.after(...)` tasks alive after the `Response` is returned.

## WebSocket (`krpc/ws`)

### Client: `wsTransport(socket)`

Wraps any Web Standard `WebSocket` (browsers, Bun, Deno, Node 22+):

```ts
import { createPeer } from 'krpc'
import { wsTransport } from 'krpc/ws'

const peer = createPeer<App>(
  wsTransport(new WebSocket('ws://localhost:3000/rpc'))
)

const off = peer.on('job.progress', ({ jobId, percent }) => {
  console.log(jobId, percent)
})

const res = await peer.call('job.start', { jobId: '1' })
off()
```

- Messages sent while `socket.readyState === WebSocket.CONNECTING` are queued and flushed in FIFO order once the socket opens (or rejected if closed before opening).
- When the socket closes, all pending in-flight requests are automatically rejected with `KrpcTransportError`.
- Reconnection policy (backoff, auth re-handshake, resubscription) is left to application code.

### Server Handler: `createWsHandler(server, options?)`

Wires a centralized-callback WebSocket server directly to an `RpcServer` via `server.connect`—managing the `WeakMap`, connection registration, `setupContext`, and `onOpen`/`onClose` lifecycle automatically:

```ts
import { createServer } from 'krpc'
import { createWsHandler } from 'krpc/ws'

const rpcServer = createServer(app)

Bun.serve<{ clientId?: string }>({
  fetch(req, server) {
    const clientId = new URL(req.url).searchParams.get('id') ?? undefined
    if (server.upgrade(req, { data: { clientId } })) return
    return new Response('Upgrade required', { status: 426 })
  },
  websocket: createWsHandler(rpcServer, {
    id: (ws) => ws.data?.clientId,
    onOpen(conn) {
      console.log('connected:', conn.id)
    },
    onClose(conn) {
      console.log('disconnected:', conn.id)
    },
  }),
})
```

### Low-Level Bridge: `createWsServerTransport(ws)`

When you need custom per-socket `createPeer` wiring (for example, server-to-client RPC calls), use `createWsServerTransport(ws)`, which returns `{ transport, handleMessage, handleClose }`:

```ts
import { createPeer } from 'krpc'
import { createWsServerTransport, type WsServerTransportBridge } from 'krpc/ws'

const bridges = new WeakMap<object, WsServerTransportBridge>()

Bun.serve({
  fetch(req, server) {
    if (server.upgrade(req)) return
    return new Response('Not Found', { status: 404 })
  },
  websocket: {
    open(ws) {
      const bridge = createWsServerTransport(ws)
      bridges.set(ws, bridge)
      createPeer(bridge.transport, app)
    },
    message(ws, message) {
      bridges.get(ws)?.handleMessage(message)
    },
    close(ws) {
      bridges.get(ws)?.handleClose()
      bridges.delete(ws)
    },
  },
})
```

## Unified Bun Server (`krpc/bun`)

`createBunHandler(server, options?)` combines `createHttpHandler` and `createWsHandler` into a single `{ fetch, websocket }` object backed by one `RpcServer`. It uses pure structural TypeScript types with zero Bun-only runtime imports.

```ts
import { createServer } from 'krpc'
import { createBunHandler } from 'krpc/bun'

const server = createServer(app)

// 1. Direct default export (Bun auto-starts the server)
export default createBunHandler(server, {
  path: '/rpc',
  id: (req) => new URL(req.url).searchParams.get('clientId') ?? undefined,
  setupContext(ctx, req) {
    ctx.set(Headers, req.headers)
  },
})

// 2. Explicit Bun.serve spread
Bun.serve({
  port: 3000,
  ...createBunHandler(server, { path: '/rpc' }),
})

// 3. Custom fetch composition
const rpc = createBunHandler(server)
Bun.serve({
  port: 3000,
  fetch(req, srv) {
    if (new URL(req.url).pathname === '/health') return new Response('ok')
    return rpc.fetch(req, srv)
  },
  websocket: rpc.websocket,
})
```

- `GET` requests with `Upgrade: websocket` upgrade automatically and attach `{ id, req }` so `setupContext(ctx, req)`, `onOpen(conn, req)`, and `onClose(conn, req, reason)` share the exact same `Request` abstraction as HTTP.
- All other matching requests delegate to `createHttpHandler` (supporting `maxBodySize` and `waitUntil`).
- HTTP handlers can push targeted notifications directly to connected WebSocket clients via `ctx.notify(def, payload, targetId)` or `server.notify(targetId, ...)`.

## Web Streams (`krpc/stream`)

`streamTransport({ readable, writable, framing?, maxMessageSize? })` creates a `DuplexTransport` over any Web Standard `ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>` pair (stdio, pipes, IPC, Web Workers).

```ts
import { createPeer } from 'krpc'
import { streamTransport } from 'krpc/stream'

const transport = streamTransport({
  readable,
  writable,
  framing: 'content-length', // default: 'ndjson'
  maxMessageSize: 16 * 1024 * 1024, // default: 16 MiB
})

const peer = createPeer(transport, app)
```

### Framing Modes

- **`ndjson`** (default): One UTF-8 JSON message per `\n`-terminated line. Simple and human-readable for CLIs and pipes.
- **`content-length`**: LSP-style `Content-Length: <bytes>\r\n\r\n<utf8-json>` framing using exact UTF-8 byte counts (`TextEncoder` / `TextDecoder`). Safely handles fragmented chunks, coalesced frames, and multi-byte UTF-8 characters split across chunks.

Both modes enforce `maxMessageSize` to guard against unbounded buffers. Low-level framing helpers (`encodeNdjsonFrame`, `createNdjsonDecoder`, `encodeContentLengthFrame`, `createContentLengthDecoder`) are also exported from `krpc/stream` for custom byte-stream integrations.

## Stdio & Subprocesses (`krpc/stdio`)

`stdioTransport(options?)` adapts standard I/O or child-process pipes into a framed `DuplexTransport` using pure structural types (zero `node:*` or `bun` runtime imports). It accepts both Web Standard streams (`ReadableStream` / `WritableStream`) and Node / Bun stream handles (`process.stdin`, `process.stdout`, `Bun.spawn` pipes).

### CLI / MCP / LSP Server (`process.stdin` & `process.stdout`)

With no arguments, `stdioTransport()` binds to `process.stdin` and `process.stdout` using `'ndjson'` framing (or pass `{ framing: 'content-length' }` for LSP-style framing):

```ts
import { createPeer } from 'krpc'
import { stdioTransport } from 'krpc/stdio'
import { app } from './app'

// Serves JSON-RPC over stdin/stdout; exits cleanly when stdin reaches EOF
const peer = createPeer(stdioTransport(), app)
```

### Parent / Child Subprocess (`Bun.spawn`)

Connect a parent process to a spawned worker over OS pipes:

```ts
import { createPeer } from 'krpc'
import { stdioTransport } from 'krpc/stdio'
import type { App } from './app'

const proc = Bun.spawn([process.execPath, './worker.ts'], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})

const peer = createPeer<App>(
  stdioTransport({
    input: proc.stdout,
    output: proc.stdin,
    framing: 'ndjson', // or 'content-length'
  })
)

const res = await peer.call('ping')
await peer.close() // closes proc.stdin so the child receives EOF and exits cleanly
await proc.exited
```

- **Framing**: Supports `'ndjson'` (default) and `'content-length'`, plus `maxMessageSize` (default: 16 MiB), sharing the exact same framing codec as `krpc/stream`.
- **Backpressure & flushing**: Respects Node `Writable` backpressure (`write() === false` -> `once('drain')`) and calls `flush?.()` for Bun `FileSink` handles automatically.
- **Clean shutdown (`closeStreams`)**: Defaults to `true` for explicitly provided streams (cancelling readers / ending sinks) and `false` for global `process.stdin` / `process.stdout` (detaching listeners and calling `process.stdin.pause()` so CLI processes exit without hanging).

## MessagePort & Web Workers (`krpc/port`)

`portTransport(port)` adapts any Web Standard `MessagePort`, `Worker`, or `DedicatedWorkerGlobalScope` into a `DuplexTransport`:

```ts
import { createPeer } from 'krpc'
import { portTransport } from 'krpc/port'

// Example with MessageChannel (same API works with new Worker(...) or self)
const { port1, port2 } = new MessageChannel()
const serverPeer = createPeer(portTransport(port1), app)
const clientPeer = createPeer<App>(portTransport(port2))

const res = await clientPeer.call('ping')
await clientPeer.close()
await serverPeer.close()
```

- Automatically calls `port.start?.()` so `MessagePort` instances deliver messages immediately with `addEventListener`.
- Accepts string, structured object/array, and binary (`ArrayBuffer` / `ArrayBufferView`) inbound payloads cleanly.
- Unsubscribes listeners on `close()`, calls `port.close?.()`, and fires `onClose` idempotently.

## Writing a Custom Transport

### `ClientTransport` Interface

```ts
export interface TransportSendOptions {
  readonly signal?: AbortSignal
}

export type ClientTransport = (
  payload: JsonRpcRequestPayload,
  options?: TransportSendOptions
) => Promise<JsonRpcResponsePayload | void>
```

Example—wrapping any `ClientTransport` with latency logging:

```ts
import type { ClientTransport } from 'krpc'

export function withLogging(inner: ClientTransport): ClientTransport {
  return async (payload, options) => {
    const start = performance.now()
    try {
      return await inner(payload, options)
    } finally {
      const ms = (performance.now() - start).toFixed(1)
      console.log(`rpc batch/call finished in ${ms}ms`)
    }
  }
}
```

### `DuplexTransport` Interface

```ts
export interface DuplexTransport {
  send(message: string): void | Promise<void>
  onMessage(handler: (message: string) => void): () => void
  onClose(handler: (reason?: unknown) => void): () => void
  close(): void | Promise<void>
}
```

`DuplexTransport` passes raw UTF-8 JSON strings so `createPeer` handles `JSON.parse` and `-32700` Parse errors automatically.

Example—a `BroadcastChannel` transport for cross-tab messaging:

```ts
import type { DuplexTransport } from 'krpc'

export function broadcastChannelTransport(
  channel: BroadcastChannel
): DuplexTransport {
  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()
  let closed = false

  const onChannelMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    for (const handler of messageHandlers) handler(event.data)
  }

  channel.addEventListener('message', onChannelMessage)

  return {
    send(message) {
      if (closed) throw new Error('Transport is closed')
      channel.postMessage(message)
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    close() {
      if (closed) return
      closed = true
      channel.removeEventListener('message', onChannelMessage)
      channel.close()
      for (const handler of closeHandlers) handler()
      messageHandlers.clear()
      closeHandlers.clear()
    },
  }
}
```

### Author Checklist

- **Pass raw strings in `DuplexTransport`**: Let `Peer` handle `JSON.parse` and `-32700` Parse errors.
- **Return idempotent unsubscribe functions** from `onMessage` and `onClose`.
- **Fire `onClose` at most once** on close or disconnect so pending calls reject cleanly.
- **Respect `AbortSignal`** in `ClientTransport` and throw `KrpcTransportError` on transport failures.
