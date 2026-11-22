import { KrpcTimeoutError, KrpcTransportError } from '../protocol/errors'
import { isJsonRpcErrorResponse, isJsonRpcResponse } from '../protocol/guards'
import {
  err,
  ok,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcSingleRequest,
  type Result,
  type StandardRpcError,
} from '../protocol/types'
import type {
  InferError,
  InferInput,
  InferOutput,
  MethodNames,
  UntypedService,
} from '../service/types'
import type { ClientTransport } from '../transports/types'

/** Per-invocation options for client requests, notifications, and batches. */
export interface CallOptions {
  /** Signal used to cancel the call locally and propagate cancellation to the transport. */
  readonly signal?: AbortSignal
  /** Timeout in milliseconds for this call (overrides `ClientOptions.timeout`). */
  readonly timeout?: number
}

/** Configuration options for `createClient`. */
export interface ClientOptions {
  /** Default request timeout in milliseconds (`undefined` disables default timeout). */
  readonly timeout?: number
  /** Custom JSON-RPC request `id` generator (defaults to monotonic integers `1, 2, 3, ...`). */
  readonly nextId?: () => JsonRpcId
}

/**
 * Smart argument tuple for `client.call` / `client.notify` / proxy calls:
 * omits `params` for `void` methods, makes optional params optional,
 * and allows a trailing `CallOptions` without ambiguous runtime heuristics.
 */
export type CallArgsWithOptions<Input> = [Input] extends [void | undefined]
  ? [] | [params: undefined, options?: CallOptions]
  : undefined extends Input
    ? [params?: Exclude<Input, undefined>, options?: CallOptions]
    : [params: Input, options?: CallOptions]

/** Single RPC request entry produced by `b.call(...)` inside `client.batch`. */
export interface BatchCallItem<Value = unknown, Error = StandardRpcError> {
  /** Discriminant identifying a Request slot expecting a `Result`. */
  readonly kind: 'call'
  /** Dot-separated RPC method name. */
  readonly method: string
  /** Optional structured JSON-RPC parameters. */
  readonly params?: JsonRpcParams
  /** Phantom result type for variadic tuple inference. */
  readonly _result?: Result<Value, Error>
}

/** Single RPC notification entry produced by `b.notify(...)` inside `client.batch`. */
export interface BatchNotifyItem {
  /** Discriminant identifying a Notification slot (no response, resolves to `undefined`). */
  readonly kind: 'notify'
  /** Dot-separated RPC method name. */
  readonly method: string
  /** Optional structured JSON-RPC parameters. */
  readonly params?: JsonRpcParams
  /** Phantom result type (`undefined`). */
  readonly _result?: undefined
}

/** Union of valid items inside a `client.batch` builder tuple. */
export type BatchItem = BatchCallItem<any, any> | BatchNotifyItem

/** Variadic tuple mapping each `BatchItem` slot to its exact `Result` or `undefined`. */
export type BatchResults<T extends readonly BatchItem[]> = {
  -readonly [K in keyof T]: T[K] extends BatchCallItem<infer Value, infer Error>
    ? Result<Value, Error>
    : T[K] extends BatchNotifyItem
      ? undefined
      : never
}

/** Builder passed to `client.batch((b) => [...])` to construct typed batch entries. */
export interface BatchBuilder<App = UntypedService> {
  /** Enqueue a JSON-RPC Request in the batch. */
  call<K extends MethodNames<App>>(
    method: K,
    ...args: [InferInput<App, K>] extends [void | undefined]
      ? []
      : undefined extends InferInput<App, K>
        ? [params?: Exclude<InferInput<App, K>, undefined>]
        : [params: InferInput<App, K>]
  ): BatchCallItem<InferOutput<App, K>, InferError<App, K>>
  /** Enqueue a JSON-RPC Notification in the batch (resolves to `undefined`). */
  notify<K extends MethodNames<App>>(
    method: K,
    ...args: [InferInput<App, K>] extends [void | undefined]
      ? []
      : undefined extends InferInput<App, K>
        ? [params?: Exclude<InferInput<App, K>, undefined>]
        : [params: InferInput<App, K>]
  ): BatchNotifyItem
}

/** Type-safe JSON-RPC 2.0 client created by `createClient`. */
export interface KrpcClient<App = UntypedService> {
  /** Phantom service type carrier enabling `createProxy(client)` type inference. */
  readonly _app?: App
  /** Invoke an RPC method and resolve to a typed `Result` (throws only on infrastructure errors). */
  call<K extends MethodNames<App>>(
    method: K,
    ...args: CallArgsWithOptions<InferInput<App, K>>
  ): Promise<Result<InferOutput<App, K>, InferError<App, K>>>
  /** Send a fire-and-forget JSON-RPC Notification (no `id`, no response). */
  notify<K extends MethodNames<App>>(
    method: K,
    ...args: CallArgsWithOptions<InferInput<App, K>>
  ): Promise<void>
  /** Execute a typed JSON-RPC 2.0 batch preserving per-slot result tuple types. */
  batch<const T extends readonly BatchItem[]>(
    build: (b: BatchBuilder<App>) => T,
    options?: CallOptions
  ): Promise<BatchResults<T>>
}

/** @internal Build a standard AbortError when `signal.reason` is absent. */
export function getAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason
  }
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * @internal Execute an async operation with optional timeout and external `AbortSignal`.
 * Zero timer or `AbortController` allocations occur when neither is configured.
 */
export function runWithCallOptions<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  defaultTimeout: number | undefined,
  options?: CallOptions
): Promise<T> {
  const timeoutMs = options?.timeout ?? defaultTimeout
  const hasTimeout = timeoutMs !== undefined && Number.isFinite(timeoutMs)
  const externalSignal = options?.signal

  if (!hasTimeout && !externalSignal) {
    return run(undefined)
  }

  if (externalSignal?.aborted) {
    return Promise.reject(getAbortReason(externalSignal))
  }

  if (hasTimeout && timeoutMs <= 0) {
    return Promise.reject(new KrpcTimeoutError(timeoutMs))
  }

  if (!hasTimeout && externalSignal) {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(getAbortReason(externalSignal))
      externalSignal.addEventListener('abort', onAbort, { once: true })

      run(externalSignal).then(
        (value) => {
          externalSignal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (reason) => {
          externalSignal.removeEventListener('abort', onAbort)
          reject(
            externalSignal.aborted ? getAbortReason(externalSignal) : reason
          )
        }
      )
    })
  }

  const controller = new AbortController()
  let timedOut = false

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }

    const onExternalAbort = () => {
      cleanup()
      const reason = getAbortReason(externalSignal as AbortSignal)
      controller.abort(reason)
      reject(reason)
    }

    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const timer = setTimeout(() => {
      timedOut = true
      cleanup()
      const timeoutErr = new KrpcTimeoutError(timeoutMs as number)
      controller.abort(timeoutErr)
      reject(timeoutErr)
    }, timeoutMs)

    run(controller.signal).then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (reason) => {
        cleanup()
        if (timedOut) {
          reject(new KrpcTimeoutError(timeoutMs as number))
        } else if (externalSignal?.aborted) {
          reject(getAbortReason(externalSignal))
        } else {
          reject(reason)
        }
      }
    )
  })
}

/** @internal Shared runtime `BatchBuilder` singleton (stateless, pure). */
export const batchBuilder = {
  call(method: string, params?: JsonRpcParams): BatchCallItem {
    return params === undefined
      ? { kind: 'call', method }
      : { kind: 'call', method, params }
  },
  notify(method: string, params?: JsonRpcParams): BatchNotifyItem {
    return params === undefined
      ? { kind: 'notify', method }
      : { kind: 'notify', method, params }
  },
}

/** Create a type-safe JSON-RPC 2.0 client over any one-way `ClientTransport`. */
export function createClient<App = UntypedService>(
  transport: ClientTransport,
  options: ClientOptions = {}
): KrpcClient<App> {
  const defaultTimeout = options.timeout
  let seq = 0
  const nextId = options.nextId ?? (() => ++seq)

  const call = async (
    method: string,
    params?: JsonRpcParams,
    callOptions?: CallOptions
  ): Promise<Result<any, any>> => {
    const id = nextId()
    const request: JsonRpcRequest =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params }

    const response = await runWithCallOptions(
      (signal) => transport(request, signal ? { signal } : undefined),
      defaultTimeout,
      callOptions
    )

    if (!isJsonRpcResponse(response)) {
      throw new KrpcTransportError('Invalid JSON-RPC response payload')
    }
    if (response.id !== id) {
      throw new KrpcTransportError(
        `Mismatched JSON-RPC response id: expected ${String(id)}, received ${String(response.id)}`
      )
    }

    return isJsonRpcErrorResponse(response)
      ? err(response.error)
      : ok(response.result)
  }

  const notify = async (
    method: string,
    params?: JsonRpcParams,
    callOptions?: CallOptions
  ): Promise<void> => {
    const notification: JsonRpcNotification =
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params }

    await runWithCallOptions(
      (signal) => transport(notification, signal ? { signal } : undefined),
      defaultTimeout,
      callOptions
    )
  }

  const batch = async <const T extends readonly BatchItem[]>(
    build: (b: BatchBuilder<App>) => T,
    callOptions?: CallOptions
  ): Promise<BatchResults<T>> => {
    const items = build(batchBuilder as BatchBuilder<App>)
    if (items.length === 0) {
      return [] as unknown as BatchResults<T>
    }

    const payload: JsonRpcSingleRequest[] = new Array(items.length)
    const idToSlot = new Map<JsonRpcId, number>()
    const results = new Array<Result<any, any> | undefined>(items.length)

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as BatchItem
      if (item.kind === 'call') {
        const id = nextId()
        if (idToSlot.has(id)) {
          throw new KrpcTransportError(
            `Duplicate JSON-RPC request id in batch: ${String(id)}`
          )
        }
        idToSlot.set(id, i)
        payload[i] =
          item.params === undefined
            ? { jsonrpc: '2.0', id, method: item.method }
            : { jsonrpc: '2.0', id, method: item.method, params: item.params }
      } else {
        payload[i] =
          item.params === undefined
            ? { jsonrpc: '2.0', method: item.method }
            : { jsonrpc: '2.0', method: item.method, params: item.params }
      }
    }

    const rawResponse = await runWithCallOptions(
      (signal) => transport(payload, signal ? { signal } : undefined),
      defaultTimeout,
      callOptions
    )

    if (idToSlot.size === 0) {
      return results as unknown as BatchResults<T>
    }

    if (!Array.isArray(rawResponse)) {
      throw new KrpcTransportError(
        'Expected JSON-RPC batch response array for batch request'
      )
    }

    let matched = 0
    for (const entry of rawResponse) {
      if (!isJsonRpcResponse(entry)) {
        throw new KrpcTransportError(
          'Invalid JSON-RPC response item inside batch response'
        )
      }
      const slot = idToSlot.get(entry.id)
      if (slot === undefined) {
        continue
      }
      if (results[slot] !== undefined) {
        throw new KrpcTransportError(
          `Duplicate JSON-RPC response id in batch: ${String(entry.id)}`
        )
      }
      results[slot] = isJsonRpcErrorResponse(entry)
        ? err(entry.error)
        : ok(entry.result)
      matched++
    }

    if (matched !== idToSlot.size) {
      throw new KrpcTransportError(
        `Incomplete JSON-RPC batch response: expected ${idToSlot.size} responses, received ${matched}`
      )
    }

    return results as unknown as BatchResults<T>
  }

  return {
    call: call as KrpcClient<App>['call'],
    notify: notify as KrpcClient<App>['notify'],
    batch,
  }
}
