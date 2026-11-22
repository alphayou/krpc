# Internal Architecture (Agent Reference)

## Module Map

```text
src/
├── index.ts              # "krpc" entry point (core DSL, client/server/peer, memory & batchTransport)
├── http.ts               # "krpc/http" entry point
├── ws.ts                 # "krpc/ws" entry point
├── bun.ts                # "krpc/bun" entry point (pure structural Bun.serve HTTP + WS adapter)
├── stream.ts             # "krpc/stream" entry point
├── port.ts               # "krpc/port" entry point
├── protocol/             # JSON-RPC 2.0 wire types, guards, errors, inline Standard Schema v1
├── service/              # defineService, defineMethod, defineNotify, defineContext, on* hooks, type utils
├── server/               # createServer (dispatch, hooks, batch limits, ctx.after, connect/notify registry)
├── client/               # createClient (call/notify/batch/timeout/abort), createProxy
├── peer/                 # createPeer (full-duplex RpcServer + KrpcClient + push notifications)
└── transports/           # ClientTransport, DuplexTransport, memory, batch, http, ws, bun, stream, port
tests/                    # Mirrors src/ plus compile-time tests/types.test.ts and tests/treeshake.test.ts
examples/                 # Runnable end-to-end examples (HTTP, WebSocket, Streams, MessagePort)
bench/                    # Zero-dependency micro-benchmarks (`bun run bench`)
```

## Dependency & Runtime Boundaries

- Layer direction: `protocol` -> `service` -> `server` / `client` / `peer` -> `transports`. Avoid upward or cyclic imports.
- `src/` must stay **zero-dependency** and **pure Web Standard / ESNext** (`fetch`, `Request`, `Response`, `WebSocket`, `ReadableStream`, `WritableStream`, `AbortSignal`, `TextEncoder`, `TextDecoder`). Never import `bun`, `node:*`, or third-party packages inside `src/`.
- `tests/` may use `bun:test` and `Bun.serve` for real HTTP/WebSocket integration testing.

## Design Invariants

### API Grammar

- `define*`: `defineService`, `defineMethod`, `defineNotify`, `defineError`, `defineContext`.
- `on*`: `onBefore`, `onAfter`, `onError` — captured synchronously during `defineService(() => ...)` execution (never use `AsyncLocalStorage`; throw if called outside `defineService`).
- `use*`: User-defined composables grouping `on*` hooks.
- `create*`: `createServer`, `createClient`, `createProxy`, `createPeer`, `createHttpHandler`, `createWsHandler`, `createBunHandler`.

### Service Compilation

- Attaching parent hooks in `defineService` must clone/wrap metadata without mutating imported child method definitions, so both `{ child }` namespacing and `{ ...child }` spreading behave cleanly.
- `compileService` flattens the tree once into an O(1) `Map<string, CompiledMethod>` and a `WeakMap<NotifyDef, string>` so `ctx.notify(def, payload)` resolves dot-separated names without string repetition.

### Type-Level Invariants (TypeScript 7)

- **Automatic Result splitting**: Handlers return values or `RpcErrorValue` (from `defineError`); client types split `Awaited<R>` via `Exclude` / `Extract` without manual `errors: [...]` declarations.
- **Structured `params` only**: `defineMethod` and `defineNotify` reject primitive parameter types at compile time.
- **Standard Schema v1**: Client infers `InferInput<S>`; server handler receives `InferOutput<S>`.
- **Reserved error codes**: `defineError` rejects `-32700`, `-32600`, `-32601`, `-32602`, `-32603` at compile time.
- **Variadic `const` batch tuples**: `client.batch` preserves per-slot `Result` / `undefined` types without `as const`.

### Wire & Error Boundaries

- Missing `id` = Notification (never emits a response; awaited by `server.handle()`; errors routed to `onError`). `id: null` = Request (must emit a response).
- **Result vs. Throw**: Protocol and domain errors return `{ ok: false, error }`; infrastructure failures throw (`KrpcTransportError`, `KrpcTimeoutError`, `AbortError`).
- **Orthogonal transports**: `ClientTransport` is a single async function; `DuplexTransport` passes raw UTF-8 JSON strings so `Peer` centralizes `JSON.parse` and `-32700` Parse error handling.

## KISS & Hot-Path Performance

- Prefer small, flat functions and direct data structures over classes, factories, or indirection layers.
- Do not add speculative options, reconnect queues, or non-standard wire extensions (e.g. `$/cancelRequest`).
- Keep hot paths allocation-light and **tree-shake pure** (`sideEffects: false`):
  - Zero module-level side effects in `src/` and named ESM exports only (keep `client`, `server`, `peer`, and `proxy` loosely coupled).
  - Pre-compile method `Map`s, flattened hook arrays, and `WeakMap<NotifyDef, string>` at setup time (zero tree traversal per request).
  - Lazily allocate `RpcContext`'s backing `Map` on first `set()`; skip timer/`AbortController` creation when no `timeout`/`signal` is set.
  - Lazily initialize singleton `TextEncoder`/`TextDecoder` helpers on first use (no bare top-level instantiation), use `method.startsWith('rpc.')` instead of RegExp, and avoid `O(n²)` buffer copies in `stream.ts` framing.
