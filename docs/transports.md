# Transports

`krpc` supports two transport models:

- **`ClientTransport`** — unidirectional request/response (used with `createClient`).
- **`DuplexTransport`** — bidirectional message stream (used with `createPeer`).

## Built-in Transports

| Entry Point   | Exports                                                                                                                 | Model           | Best For                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------- |
| `krpc`        | `createMemoryTransport`, `createMemoryDuplexPair`, `isDuplexTransport`                                                  | Client & Duplex | Unit tests, SSR, in-process calls               |
| `krpc/http`   | `httpTransport`, `createHttpHandler`                                                                                    | Client + Fetch  | `Bun.serve`, Cloudflare Workers, Hono, browsers |
| `krpc/ws`     | `wsTransport`, `createWsServerTransport`                                                                                | Duplex          | Real-time apps, server push, bidirectional RPC  |
| `krpc/stream` | `streamTransport`, `encodeNdjsonFrame`, `createNdjsonDecoder`, `encodeContentLengthFrame`, `createContentLengthDecoder` | Duplex          | stdio, Web Workers, pipes, LSP-style framing    |

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

### Server Bridge: `createWsServerTransport(ws)`

Adapts server-side WebSocket APIs such as `Bun.serve`'s `ServerWebSocket` (where `message` and `close` callbacks live on the server handler). It returns a `WsServerTransportBridge` (`{ transport, handleMessage, handleClose }`):

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

Example—a `MessagePort` transport for Web Workers or `MessageChannel`:

```ts
import type { DuplexTransport } from 'krpc'

export function messagePortTransport(port: MessagePort): DuplexTransport {
  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()
  let closed = false

  const onPortMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    for (const handler of messageHandlers) handler(event.data)
  }

  port.addEventListener('message', onPortMessage)
  port.start()

  return {
    send(message) {
      if (closed) throw new Error('Transport is closed')
      port.postMessage(message)
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
      port.removeEventListener('message', onPortMessage)
      port.close()
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
