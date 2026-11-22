# krpc

Type-safe, zero-dependency JSON-RPC 2.0 library for TypeScript built on Web Standard APIs.

[![CI](https://github.com/alphayou/krpc/actions/workflows/ci.yml/badge.svg)](https://github.com/alphayou/krpc/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](./LICENSE)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

## Highlights

- **Strict JSON-RPC 2.0**: Spec-compliant Request, Notification, Batch, and standard error semantics—no proprietary wire extensions.
- **Declarative DSL**: Vue 3 / Pinia-inspired `defineService`, `defineMethod`, `defineNotify`, `defineError`, `defineContext`, and synchronous `onBefore` / `onAfter` / `onError` hooks + `use*` composables.
- **Type-safe & external-server ready**: Automatic `Result` / domain-error splitting, compile-time structured `params` enforcement, variadic `batch` tuples, and recursive `createProxy`—or omit `<App>` to call any external JSON-RPC 2.0 server (Ethereum, LSP, MCP).
- **Standard Schema v1**: Plug in Zod, Valibot, ArkType, or any [Standard Schema v1](https://standardschema.dev/) validator with zero runtime dependencies.
- **Result vs. Throw boundary**: Protocol and domain errors always return `{ ok: false, error }`; infrastructure errors throw `KrpcTransportError`, `KrpcTimeoutError`, or `AbortError`.
- **Tiny, pure Web Standard transports**: Zero dependencies and `~5 kB` minified client bundle (`createClient` + `httpTransport`), with tree-shakeable ESM subpaths (`krpc`, `krpc/http`, `krpc/ws`, `krpc/stream`, `krpc/port`) portable across Bun, Node.js, Deno, Cloudflare Workers, and browsers.

## Install

```bash
bun add krpc
# or
pnpm add krpc
# or
npm install krpc
```

## Quick Start

### 1. Define Services, Errors & Context

```ts
import {
  defineContext,
  defineError,
  defineMethod,
  defineNotify,
  defineService,
  onBefore,
} from 'krpc'

export const Headers = defineContext<Headers>()
const CurrentUser = defineContext<{ id: string }>()

const Unauthorized = defineError(-32001, 'Unauthorized')
const DivByZero = defineError(-32002, 'Division by zero')
export const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

function useAuth() {
  onBefore((ctx) => {
    const token = ctx.get(Headers)?.get('authorization')
    if (!token) return Unauthorized()
    ctx.set(CurrentUser, { id: 'user_1' })
  })
}

const math = defineService(() => {
  const divide = defineMethod(({ a, b }: { a: number; b: number }) => {
    if (b === 0) return DivByZero()
    if (a > 1e9) return Overflow({ max: 1e9 })
    return a / b
  })

  const sum = defineMethod(([a, b]: [number, number]) => a + b)

  return { divide, sum }
})

const job = defineService(() => {
  useAuth()

  const progress = defineNotify<{ jobId: string; percent: number }>()

  const start = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
    const user = ctx.require(CurrentUser)
    await ctx.notify(progress, { jobId, percent: 50 })
    await ctx.notify(progress, { jobId, percent: 100 })
    return { startedBy: user.id }
  })

  return { start, progress }
})

export const app = defineService(() => {
  const ping = defineMethod(() => 'pong' as const)
  const log = defineMethod(({ message }: { message: string }) => {
    console.log(message)
  })

  return { ping, log, math, job }
})

export type App = typeof app
```

### 2. Serve over HTTP (`krpc/http`)

```ts
import { createServer } from 'krpc'
import { createHttpHandler } from 'krpc/http'
import { app, Headers } from './app'

const server = createServer(app, { maxBatchSize: 50, batchConcurrency: 10 })
const rpcHandler = createHttpHandler(server, {
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

### 3. Call with Client, Batch & Proxy

```ts
import { createClient, createProxy } from 'krpc'
import { httpTransport } from 'krpc/http'
import { Overflow, type App } from './app'

const client = createClient<App>(httpTransport('http://localhost:3000/rpc'), {
  timeout: 5_000,
})

// Typed Result (domain & protocol errors never throw)
const res = await client.call('math.divide', { a: 10, b: 0 })
if (!res.ok) {
  if (Overflow.is(res.error)) {
    console.log('Limit:', res.error.data.max)
  } else {
    console.log(res.error.code, res.error.message)
  }
} else {
  console.log('Result:', res.value)
}

// Fire-and-forget JSON-RPC Notification
await client.notify('log', { message: 'hello' })

// Variadic tuple batch (no `as const` needed)
const [divRes, sumRes, logRes] = await client.batch((b) => [
  b.call('math.divide', { a: 10, b: 2 }),
  b.call('math.sum', [1, 2]),
  b.notify('log', { message: 'done' }),
])

// Optional property-style proxy
const rpc = createProxy(client)
await rpc.math.divide({ a: 10, b: 2 })
```

### 4. Full-Duplex Peer & Push Notifications (`krpc/ws`)

```ts
import { createPeer } from 'krpc'
import { wsTransport } from 'krpc/ws'
import type { App } from './app'

const peer = createPeer<App>(
  wsTransport(new WebSocket('ws://localhost:3000/rpc'))
)

const off = peer.on('job.progress', ({ jobId, percent }) => {
  console.log(jobId, percent)
})

await peer.call('job.start', { jobId: '42' })
off()
await peer.close()
```

## Entry Points

| Import        | Exports                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `krpc`        | Core DSL, `createServer`, `createClient`, `createProxy`, `createPeer`, `batchTransport`, memory transports |
| `krpc/http`   | `httpTransport`, `createHttpHandler`                                                                       |
| `krpc/ws`     | `wsTransport`, `createWsServerTransport`                                                                   |
| `krpc/stream` | `streamTransport`, `ndjson` and `content-length` framing helpers                                           |
| `krpc/port`   | `portTransport` for `MessagePort`, `Worker`, and `DedicatedWorkerGlobalScope`                              |

## Documentation

- [Guide](./docs/guide.md) — Services, validation, errors, context, hooks, clients, peers, and type utilities
- [Transports](./docs/transports.md) — Memory, auto-batching (`batchTransport`), HTTP, WebSocket, Web Streams, `MessagePort` / Workers, and custom transports
- [Protocol Reference](./docs/protocol.md) — JSON-RPC 2.0 compliance matrix, error codes, batching, and cancellation
- [Examples](./examples/) — Runnable end-to-end examples (`http.ts`, `ws-peer.ts`, `stream.ts`, `port.ts`)
- [Contributing](./CONTRIBUTING.md) — Development workflow and conventions

## License

[MPL-2.0](./LICENSE)
