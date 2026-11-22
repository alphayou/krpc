# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

Initial public release of `krpc`.

### Added

- **Declarative service DSL**: `defineService`, `defineMethod`, `defineNotify`, `defineError` (with compile-time reserved error code guards and `.data<T>()`), `defineContext`, synchronous lifecycle hooks (`onBefore`, `onAfter`, `onError`), reusable `use*` composables, and zero-dependency Standard Schema v1 validation (input and output).
- **End-to-end TypeScript inference**: Automatic `Result` / domain-error splitting from handler return values, compile-time structured `params` enforcement, variadic `client.batch` tuples without `as const`, recursive `createProxy`, and type utilities (`MethodNames`, `NotifyNames`, `InferInput`, `InferOutput`, `InferError`, `InferNotify`).
- **Untyped external client support**: `createClient(transport)` and client-only `createPeer(transport)` work without an `<App>` generic to call any external JSON-RPC 2.0 server (e.g. Ethereum, LSP, MCP), returning `Result<unknown, JsonRpcErrorObject>` and supporting recursive `createProxy`.
- **Result vs. Throw error boundary**: Protocol and domain errors always return `{ ok: false, error }`; infrastructure failures throw `KrpcTransportError`, `KrpcTimeoutError`, or `AbortError`.
- **Server, Client, Peer & Auto-Batching**:
  - `createServer` with batch limits (`maxBatchSize`), bounded `batchConcurrency`, error sanitization (`formatError`), unserializable result `-32603` safety, built-in full-duplex connection registry (`server.connect`, `server.notify`), and early reply (`ctx.after`).
  - `createClient` with variadic typed `batch`, per-call `timeout` / `AbortSignal`, and optional `createProxy`.
  - `createPeer` for full-duplex RPC and typed push notifications (`ctx.notify` with silent-drop `Promise<boolean>` and optional target `to` client ID, `ctx.clientId`, `peer.notify`, `peer.on`).
  - `batchTransport` wrapper to automatically coalesce concurrent `client.call` and `client.notify` calls into JSON-RPC 2.0 batches.
- **6 pure Web Standard entry points**:
  - `krpc`: Core DSL, `createServer`, `createClient`, `createProxy`, `createPeer`, `batchTransport`, `createMemoryTransport`, `createMemoryDuplexPair`, `isDuplexTransport`.
  - `krpc/http`: Fetch-based `httpTransport` (with `FetchLike` custom `fetch` support) and `createHttpHandler` with incremental `maxBodySize` enforcement and `waitUntil` support for `ctx.after`.
  - `krpc/ws`: Web Standard `wsTransport` (with `CONNECTING` send queue), `createWsServerTransport` bridge, and `createWsHandler` server callback adapter.
  - `krpc/bun`: Unified HTTP + WebSocket `createBunHandler` adapter for `Bun.serve` using pure structural types (zero Bun-only runtime imports).
  - `krpc/stream`: Web Streams `streamTransport` with `ndjson` and `content-length` framing helpers.
  - `krpc/port`: `portTransport` for `MessagePort`, `Worker`, and `DedicatedWorkerGlobalScope`.
- **Strict JSON-RPC 2.0 compliance**: Verified against all Section 7 specification examples, including Section 5 `void`/`undefined` -> `null` wire normalization, strict `id` and `params` validation, `rpc.` reserved method rejection, empty/mixed batch handling, and safe `-32603` fallbacks for unserializable values.
- **Zero dependencies & tree-shaking**: Pure ESM + `.d.mts` output with `sideEffects: false`, zero runtime dependencies, and a `~5 kB` minified client bundle (`createClient` + `httpTransport`), portable across Bun, Node.js, Deno, Cloudflare Workers, and browsers.
