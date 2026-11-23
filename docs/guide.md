# Guide

`krpc` is a type-safe, zero-dependency JSON-RPC 2.0 library for TypeScript built on Web Standard APIs.

## Installation

```bash
bun add @alphayou-ai/krpc
# or
pnpm add @alphayou-ai/krpc
# or
npm install @alphayou-ai/krpc
```

## Defining Services & Methods

Build your API with `defineService` and `defineMethod`. Nested services map automatically to dot-separated JSON-RPC method names (`"math.add"`, `"math.divide"`).

```ts
import { defineMethod, defineService } from '@alphayou-ai/krpc'

const math = defineService(() => {
  const add = defineMethod(({ a, b }: { a: number; b: number }) => a + b)
  const sum = defineMethod(([a, b]: [number, number]) => a + b)

  return { add, sum }
})

export const app = defineService(() => {
  const ping = defineMethod(() => 'pong' as const)
  const log = defineMethod(({ message }: { message: string }) => {
    console.log(message)
  })

  return { ping, log, math }
})

export type App = typeof app
```

Per JSON-RPC 2.0, method parameters must be structured (an object or an array) or omitted. Primitive parameters like `number` or `string` are rejected at compile time.

Handlers that return `void` or `undefined` serialize as `"result": null` on the wire (per JSON-RPC 2.0 Section 5) and infer `null` on the client (`Result<null, ...>`).

## Schema Validation (Standard Schema)

Pass any [Standard Schema v1](https://standardschema.dev/) validator (such as Zod, Valibot, or ArkType) as the first argument to `defineMethod`. `krpc` infers the **input** type on the client and the validated **output** type inside the handler.

```ts
import { defineMethod } from '@alphayou-ai/krpc'
import { z } from 'zod'

const greet = defineMethod(
  z.object({
    name: z.string().min(1),
    excited: z.boolean().default(false),
  }),
  ({ name, excited }) => (excited ? `Hello, ${name}!` : `Hello, ${name}`)
)
```

- Callers can omit `excited` (`client.call('greet', { name: 'Ada' })`).
- Inside the handler, `excited` is guaranteed to be `boolean`.
- Validation failures automatically return JSON-RPC `-32602` (`Invalid params`) with concise issue details.
- You can also validate outputs by passing `{ input, output }` as the first argument to `defineMethod` (output validation failures return `-32603` `Internal error`).

## Typed Domain Errors

Declare domain errors with `defineError` and return them directly from handlers. `krpc` automatically splits returned values into the client's `Result` union—no separate error list required.

```ts
import { defineError, defineMethod } from '@alphayou-ai/krpc'

const DivByZero = defineError(-32002, 'Division by zero')
const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

const divide = defineMethod(({ a, b }: { a: number; b: number }) => {
  if (b === 0) return DivByZero()
  if (a > 1e9) return Overflow({ max: 1e9 })
  return a / b
})
```

On the client, narrow errors by literal `code` or with the `.is()` type guard:

```ts
const res = await client.call('math.divide', { a: 10, b: 0 })

if (!res.ok) {
  if (Overflow.is(res.error)) {
    console.log(res.error.data.max) // number
  } else if (res.error.code === -32002) {
    console.log(res.error.message) // "Division by zero"
  }
} else {
  console.log(res.value) // number
}
```

Standard JSON-RPC reserved codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`) are blocked at compile time in `defineError`.

## Context, Hooks & Composables

Use `defineContext` for typed per-request state, and register `onBefore`, `onAfter`, and `onError` synchronously inside `defineService`. Group reusable hooks into `use*` composables.

```ts
import {
  defineContext,
  defineError,
  defineMethod,
  defineService,
  onBefore,
  onError,
} from '@alphayou-ai/krpc'

const Headers = defineContext<Headers>() // optional: ctx.get -> Headers | undefined
const Locale = defineContext('en-US') // defaulted: ctx.get -> string
const CurrentUser = defineContext<{ id: string }>()

const Unauthorized = defineError(-32001, 'Unauthorized')

function useAuth() {
  onBefore((ctx) => {
    const user = verifyToken(ctx.get(Headers)?.get('authorization'))
    if (!user) return Unauthorized()
    ctx.set(CurrentUser, user)
  })
}

const account = defineService(() => {
  useAuth()
  onError((err, ctx) => console.error(ctx.method, err))

  const me = defineMethod((_params: void, ctx) => ({
    user: ctx.require(CurrentUser),
    locale: ctx.get(Locale),
  }))

  return { me }
})
```

- `ctx.get(Token)` returns `T | undefined` for tokens without a default, or `T` when a default was provided.
- `ctx.require(Token)` returns `T` and throws if the value was not set.
- Hooks declared on a parent service automatically apply to its nested child services.

## Creating a Server & Client

Wire up a server with `createServer` and expose it over any transport (such as `@alphayou-ai/krpc/http` or `createMemoryTransport` for tests):

```ts
import { createClient, createServer } from '@alphayou-ai/krpc'
import { createHttpHandler, httpTransport } from '@alphayou-ai/krpc/http'
import { app, type App } from './app'

// Server
const server = createServer(app, {
  maxBatchSize: 50,
  batchConcurrency: 10,
})

const handler = createHttpHandler(server, {
  setupContext(ctx, req) {
    ctx.set(Headers, req.headers)
  },
})

// Client
const client = createClient<App>(httpTransport('http://localhost:3000/rpc'), {
  timeout: 5_000,
})
```

### Calling Methods & Sending Notifications

```ts
// Zero-argument call (pass `undefined` before per-call options if needed)
const pong = await client.call('ping')
const fastPong = await client.call('ping', undefined, { timeout: 1_000 })

// Request with params and per-call options
const res = await client.call(
  'math.add',
  { a: 1, b: 2 },
  { timeout: 2_000, signal: controller.signal }
)

// Fire-and-forget JSON-RPC Notification (no id, no response)
await client.notify('log', { message: 'hello' })
```

### Batch Requests

`client.batch` sends a single JSON-RPC batch array and preserves the exact type of every slot without `as const`:

```ts
const [addRes, sumRes, logRes] = await client.batch((b) => [
  b.call('math.add', { a: 10, b: 2 }),
  b.call('math.sum', [1, 2]),
  b.notify('log', { message: 'done' }),
])
// addRes: Result<number, StandardRpcError>
// sumRes: Result<number, StandardRpcError>
// logRes: undefined
```

To automatically coalesce concurrent `client.call` / `client.notify` calls without rewriting call sites into `client.batch`, wrap your transport with [`batchTransport`](./transports.md#auto-batching-batchtransport-in-alphayou-aikrpc).

### Proxy Client

If you prefer property-style calls over string method names, wrap any `KrpcClient` or `KrpcPeer` with `createProxy`:

```ts
import { createProxy } from '@alphayou-ai/krpc'

const rpc = createProxy(client)
const res = await rpc.math.add({ a: 10, b: 2 })
```

### Calling External / Untyped Servers

To call a third-party JSON-RPC 2.0 server (such as Ethereum, LSP, or MCP) without a `defineService` schema, omit the `<App>` type parameter on `createClient` (or client-only `createPeer`):

```ts
import { createClient, createProxy } from '@alphayou-ai/krpc'
import { httpTransport } from '@alphayou-ai/krpc/http'

const client = createClient(httpTransport('https://rpc.example.com'))

// Returns Result<unknown, JsonRpcErrorObject> (supports custom external error codes)
const res = await client.call('eth_blockNumber')
if (res.ok) {
  console.log(res.value)
} else if (res.error.code === 4001) {
  console.error('Rejected:', res.error.message)
}

// Structured params (object or array) are still enforced at compile time
await client.call('eth_getBalance', ['0x...', 'latest'])

// Works with createProxy as well
const rpc = createProxy(client)
await rpc.eth_blockNumber()
```

## Result vs. Throw

`krpc` separates RPC-level outcomes from transport failures:

- **Returns `{ ok: false, error }`**: Domain errors from `defineError` and JSON-RPC protocol errors (`-32700` .. `-32603`). Never thrown.
- **Throws**: Infrastructure errors—`KrpcTransportError` (network/HTTP failures), `KrpcTimeoutError` (timeout exceeded), and `AbortError` (`AbortSignal` aborted).

On the server, unhandled exceptions and non-JSON-serializable handler results (`BigInt`, circular objects, or throwing `toJSON`) are caught, passed to `onError` / `formatError`, and returned as `-32603` (`Internal error`) without breaking sibling batch items or crashing the transport.

```ts
import { KrpcTimeoutError, KrpcTransportError } from '@alphayou-ai/krpc'

try {
  const res = await client.call('math.divide', { a: 10, b: 0 })
  if (!res.ok) {
    console.error('RPC error:', res.error.code, res.error.message)
  }
} catch (err) {
  if (err instanceof KrpcTimeoutError) {
    console.error('Request timed out')
  } else if (err instanceof KrpcTransportError) {
    console.error('Transport failed:', err.message)
  }
}
```

## Full-Duplex Peers, Early Reply & Push Notifications

For bidirectional transports (`@alphayou-ai/krpc/ws`, `@alphayou-ai/krpc/bun`, `@alphayou-ai/krpc/stream`, `@alphayou-ai/krpc/stdio`, `@alphayou-ai/krpc/port`, or `createMemoryDuplexPair`), declare outbound notifications with `defineNotify`.

### Early Reply (`ctx.after`) & Silent-Drop `ctx.notify`

- `ctx.notify(def, params?, to?)` returns `Promise<boolean>`: it validates registration and schema first, delivers to the active duplex peer (or a connected client ID when `to` is passed), and silently drops returning `false` on HTTP, closed sockets, or offline targets (never throws transport errors). Check `ctx.canNotify` if you need to branch on transport capability.
- `ctx.after(fn)` schedules background work to run **after** the RPC response is sent without affecting the handler's inferred return type. On duplex transports (`server.connect` / `createPeer`), `ctx.after` flushes strictly after the response frame is written, guaranteeing clients receive the reply before subsequent `ctx.notify(...)` frames. On stateless HTTP, pass `waitUntil` to `createHttpHandler` / `createBunHandler` to keep background tasks alive in serverless runtimes.
- `ctx.clientId` exposes the connected client's ID (set via `server.connect` or `createPeer(..., { id })`, or `undefined` on stateless HTTP).

```ts
import {
  createPeer,
  createServer,
  defineMethod,
  defineNotify,
  defineService,
} from '@alphayou-ai/krpc'
import { createBunHandler } from '@alphayou-ai/krpc/bun'
import { wsTransport } from '@alphayou-ai/krpc/ws'

const jobs = defineService(() => {
  const progress = defineNotify<{ jobId: string; percent: number }>()

  const start = defineMethod(({ jobId }: { jobId: string }, ctx) => {
    ctx.after(async () => {
      await ctx.notify(progress, { jobId, percent: 50 })
      await ctx.notify(progress, { jobId, percent: 100 })
    })
    return { accepted: true, clientId: ctx.clientId ?? null }
  })

  // Push from any transport (including HTTP) to a specific connected WS client
  const poke = defineMethod(
    async ({ targetId, jobId }: { targetId: string; jobId: string }, ctx) => ({
      delivered: await ctx.notify(progress, { jobId, percent: 100 }, targetId),
    })
  )

  return { start, poke, progress }
})

// Single server serving both HTTP and WebSocket connections
const server = createServer(jobs)
Bun.serve({
  port: 3000,
  ...createBunHandler(server, {
    path: '/rpc',
    id: (req) => new URL(req.url).searchParams.get('clientId') ?? undefined,
  }),
})

// Push from anywhere on the server by client ID (returns false if offline)
await server.notify('user-1', 'progress', { jobId: '1', percent: 80 })
await server.notify('user-1', jobs.progress, { jobId: '1', percent: 90 })

// Client side: call methods and subscribe to server notifications
const clientPeer = createPeer<typeof jobs>(
  wsTransport(new WebSocket('ws://localhost:3000/rpc?clientId=user-1'))
)

const off = clientPeer.on('progress', ({ jobId, percent }) => {
  console.log(jobId, percent)
})

await clientPeer.call('start', { jobId: '1' })
off()
```

For point-to-point duplex connections (such as Web Streams, `MessagePort`, or bidirectional peer-to-peer RPC where both sides call each other), attach any `DuplexTransport` with `server.connect(transport, options?)` or `createPeer(transport, service, options?)`.

## Type Utilities

Extract types from any service definition without importing server implementation code:

```ts
import type {
  InferError,
  InferInput,
  InferNotify,
  InferOutput,
  MethodNames,
  NotifyNames,
} from '@alphayou-ai/krpc'
import type { App } from './app'

type Methods = MethodNames<App> // "ping" | "log" | "math.add" | ...
type Notifications = NotifyNames<App> // "job.progress" | ...
type DivideInput = InferInput<App, 'math.divide'> // { a: number; b: number }
type DivideOutput = InferOutput<App, 'math.divide'> // number
type DivideError = InferError<App, 'math.divide'> // DivByZero | Overflow | StandardRpcError
type ProgressPayload = InferNotify<App, 'job.progress'> // { jobId: string; percent: number }
```

## Next Steps

- [Transports](./transports.md) — HTTP, WebSocket, Web Streams, Memory, and writing custom transports.
- [Protocol Reference](./protocol.md) — JSON-RPC 2.0 compliance matrix, error codes, batch rules, and cancellation.
