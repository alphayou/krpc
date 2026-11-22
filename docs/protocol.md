# JSON-RPC 2.0 Protocol Reference

`krpc` implements the [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification) without proprietary wire extensions. This reference documents the wire rules, error codes, Request vs. Notification semantics, batching, and cancellation.

## Spec Compliance Matrix

| Requirement                | JSON-RPC 2.0 Rule                                                      | `krpc` Behavior                                                                             |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Protocol version           | Every message MUST include `"jsonrpc": "2.0"`                          | Missing or mismatched values return `-32600` Invalid Request                                |
| Request `id`               | `string \| number \| null`; numbers SHOULD NOT be fractional           | Accepts `string`, finite `number`, or `null`; rejects `NaN`, `Infinity`, booleans, objects  |
| Missing `id` vs `id: null` | Missing `id` is a Notification; `id: null` is a Request                | Checked via `"id" in msg`; `id: null` always produces a response                            |
| `params` structure         | If present, MUST be an object or an array                              | Primitive `params` (`number`, `string`, `boolean`, `null`) return `-32600` Invalid Request  |
| `rpc.` reserved methods    | Method names starting with `rpc.` are reserved for internal extensions | Rejected by default with `-32601` Method not found                                          |
| Invalid JSON               | Malformed JSON text MUST yield `-32700` Parse error with `id: null`    | Returns a single `-32700` Parse error response with `id: null`                              |
| Empty batch `[]`           | MUST return a single `-32600` Invalid Request response                 | Returns `{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }` |
| Mixed invalid batch items  | Invalid items produce `-32600` without blocking valid items            | Each item is validated and dispatched independently                                         |
| All-Notification batch     | Server MUST NOT return any response                                    | `server.handle()` resolves to `undefined`; HTTP responds with `204 No Content`              |
| Success vs. Error response | Exactly one of `result` or `error` MUST be present                     | Enforced by wire types and runtime validation                                               |

## Error Codes

### Standard Reserved Codes

| Code     | Constant           | Meaning                                                        |
| -------- | ------------------ | -------------------------------------------------------------- |
| `-32700` | `PARSE_ERROR`      | Invalid JSON received by the server                            |
| `-32600` | `INVALID_REQUEST`  | JSON is not a valid Request object (or empty batch `[]`)       |
| `-32601` | `METHOD_NOT_FOUND` | Method does not exist, is unavailable, or starts with `rpc.`   |
| `-32602` | `INVALID_PARAMS`   | Invalid method parameters (including Standard Schema failures) |
| `-32603` | `INTERNAL_ERROR`   | Unhandled server exception (sanitized by default)              |

### Application & Server Error Codes

- `-32000` to `-32099`: Reserved by JSON-RPC 2.0 for server-defined errors.
- Any other integer outside `-32768..-32000` (or within `-32000..-32099` for server errors): Available for custom errors via `defineError`.
- The five standard codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`) are rejected at compile time by `defineError`.

```ts
const Unauthorized = defineError(-32001, 'Unauthorized')
const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

// Compile-time error: -32600 is reserved by JSON-RPC 2.0
// const Bad = defineError(-32600, "Invalid")
```

## Request vs. Notification Semantics

### Calling a Method as a Request or Notification

In JSON-RPC 2.0, the caller decides whether an invocation expects a response:

- `client.call("log", { message: "hello" })` sends a **Request** (with `id`) and awaits a `Result`.
- `client.notify("log", { message: "hello" })` sends a **Notification** (without `id`) and expects no response.

Inside a `defineMethod` handler, check `ctx.isNotification` to detect Notification calls.

### Server Behavior for Notifications

- No response is ever emitted for a Notification—even if the method is missing, validation fails, a domain error is returned, or the handler throws.
- Errors thrown or returned during a Notification are passed to `onError` hooks instead of sent over the wire.
- `server.handle()` awaits Notification handlers before resolving so serverless runtimes and tests do not cut off async work early.

### Outbound Push Notifications

On duplex transports, declare outbound notifications with `defineNotify<Payload>()`:

- Inside a handler: `await ctx.notify(progress, { jobId, percent: 50 })` (check `ctx.canNotify` if a service also runs over HTTP).
- Outside a handler: `await serverPeer.notify("job.progress", { jobId: "1", percent: 80 })`.
- On the client peer: `const off = clientPeer.on("job.progress", (data) => { ... })`.

## Result vs. Throw Boundary

| Failure Category                                                                   | Client Behavior                | Type                                            |
| ---------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------- |
| Domain error returned via `defineError(...)`                                       | Returns `{ ok: false, error }` | Typed `{ code, message, data? }` union          |
| JSON-RPC protocol error (`-32700` .. `-32603`, server errors)                      | Returns `{ ok: false, error }` | `StandardRpcError` / `{ code, message, data? }` |
| Network failure, disconnected socket, non-2xx HTTP status, malformed non-RPC reply | **Throws**                     | `KrpcTransportError`                            |
| Call exceeded `timeout`                                                            | **Throws**                     | `KrpcTimeoutError`                              |
| Caller aborted via `AbortSignal`                                                   | **Throws**                     | `AbortError` (or `signal.reason`)               |

## Error Sanitization & `formatError`

1. **`defineError` values and `JsonRpcError` instances** are returned to the client with their `code`, `message`, and optional `data`.
2. **Standard Schema input validation failures** become `-32602` (`'Invalid params'`) with concise issue details in `data`.
3. **Output schema validation failures and unexpected thrown errors** are sanitized to `-32603` (`'Internal error'`) so stack traces and internal details are never leaked.
4. **Custom formatting**: Pass `formatError(err, ctx)` to `createServer` to map custom exceptions to a `JsonRpcError` or `JsonRpcErrorObject`:

```ts
const server = createServer(app, {
  formatError(err, ctx) {
    console.error(ctx.method, err)
    return { code: -32603, message: 'Internal error' }
  },
})
```

## Batch Execution

- JSON array payloads execute as JSON-RPC 2.0 batches concurrently by default (`batchConcurrency: Infinity`).
- `maxBatchSize` defaults to `100` to protect against oversized batches.
- Set `batchConcurrency` to bound parallelism (`batchConcurrency: 1` executes batch items serially).
- Reserved `rpc.*` methods are rejected with `-32601` by default (`allowReservedMethods: false`).
- Malformed entries produce independent `-32600` responses without failing valid sibling entries.
- If every item in a batch is a Notification, the server produces no response (`204 No Content` over HTTP).

```ts
const [divRes, sumRes, logRes] = await client.batch((b) => [
  b.call('math.divide', { a: 10, b: 2 }),
  b.call('math.sum', [1, 2]),
  b.notify('log', { message: 'done' }),
])
```

## Cancellation

`krpc` uses standard `AbortSignal` and timeout semantics without non-standard wire extensions:

- **Client**: Configure a default `timeout` on `createClient` / `createPeer`, or pass `{ timeout, signal }` per call.
- **HTTP**: Aborting a client `AbortSignal` aborts the underlying `fetch` call; on the server, `createHttpHandler` connects `req.signal` to `ctx.signal`.
- **WebSocket & Streams**: Aborting a signal or reaching `timeout` rejects the pending local promise and clears its in-flight entry immediately.
