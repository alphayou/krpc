# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Core JSON-RPC 2.0 protocol**: Strict wire types, runtime type guards, `parseJsonRpcPayload`, `Result` (`ok` / `err`), `JsonRpcError`, standard error factories, `KrpcTransportError`, `KrpcTimeoutError`, and `defineError` (with compile-time reserved error code guards and `.data<T>()`).
- **Declarative service DSL**: `defineService`, `defineMethod`, `defineNotify`, `defineContext`, synchronous lifecycle hooks (`onBefore`, `onAfter`, `onError`), composable `use*` patterns, and zero-dependency Standard Schema v1 validation.
- **Server, Client, Proxy & Peer**:
  - `createServer` with batch limits (`maxBatchSize`), bounded batch concurrency (`batchConcurrency`), context setup, and error sanitization.
  - `createClient` with variadic typed `batch`, per-call `timeout` / `AbortSignal`, and optional `createProxy`.
  - `createPeer` for full-duplex RPC and typed push notifications (`ctx.notify`, `peer.notify`, `peer.on`).
- **Transports**:
  - `krpc`: `createMemoryTransport`, `createMemoryDuplexPair`, `batchTransport` (automatic request coalescing wrapper), `isDuplexTransport`.
  - `krpc/http`: Web Fetch `httpTransport` and `createHttpHandler` with incremental `maxBodySize` enforcement.
  - `krpc/ws`: Web Standard `wsTransport` (with `CONNECTING` queue) and `createWsServerTransport` bridge.
  - `krpc/stream`: Web Streams `streamTransport` with `ndjson` and `content-length` framing helpers.
  - `krpc/port`: `portTransport` for Web Standard `MessagePort`, `Worker`, and `DedicatedWorkerGlobalScope`.
- **Developer experience**: Runnable examples (`examples/`), tree-shaking regression suite (`tests/treeshake.test.ts`), zero-dependency benchmarks (`bench/rpc.bench.ts`), and CI / provenance release workflows.
