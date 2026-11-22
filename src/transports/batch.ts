import { KrpcTransportError } from '../protocol/errors'
import { isJsonRpcErrorResponse, isJsonRpcResponse } from '../protocol/guards'
import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResponsePayload,
  JsonRpcSingleRequest,
} from '../protocol/types'
import type { ClientTransport, TransportSendOptions } from './types'

const DEFAULT_WINDOW_MS = 0
const DEFAULT_MAX_BATCH_SIZE = 50

/** Configuration options for `batchTransport`. */
export interface BatchTransportOptions {
  /**
   * Coalescing window in milliseconds (default: `0`).
   * `0` coalesces concurrent calls within the current microtask via `queueMicrotask`;
   * values `> 0` coalesce calls within a `setTimeout` window.
   */
  readonly windowMs?: number
  /**
   * Maximum number of queued calls per batch before flushing eagerly (default: `50`).
   */
  readonly maxBatchSize?: number
}

interface QueuedCall {
  readonly payload: JsonRpcSingleRequest
  readonly signal?: AbortSignal
  readonly resolve: (value: JsonRpcResponsePayload | void) => void
  readonly reject: (reason: unknown) => void
  onAbort?: () => void
  settled: boolean
}

function assertValidWindowMs(windowMs: number): void {
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError(
      `windowMs must be a finite number >= 0, received ${windowMs}`
    )
  }
}

function assertValidMaxBatchSize(maxBatchSize: number): void {
  if (
    Number.isNaN(maxBatchSize) ||
    maxBatchSize <= 0 ||
    (maxBatchSize !== Number.POSITIVE_INFINITY &&
      !Number.isInteger(maxBatchSize))
  ) {
    throw new RangeError(
      `maxBatchSize must be a positive integer or Infinity, received ${maxBatchSize}`
    )
  }
}

function getAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason
  }
  return new DOMException('The operation was aborted.', 'AbortError')
}

function hasRequestId(
  payload: JsonRpcSingleRequest
): payload is JsonRpcRequest {
  return (
    Object.prototype.hasOwnProperty.call(payload, 'id') &&
    payload.id !== undefined
  )
}

function cleanupAbort(entry: QueuedCall): void {
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort)
    entry.onAbort = undefined
  }
}

/**
 * Wrap any `ClientTransport` to automatically coalesce concurrent single JSON-RPC 2.0
 * requests and notifications into JSON-RPC 2.0 Batch arrays.
 *
 * Pre-batched arrays pass straight through to `transport` without nesting.
 * When only a single item is queued at flush time, it is dispatched directly as a
 * single object rather than a 1-element batch array.
 */
export function batchTransport(
  transport: ClientTransport,
  options?: BatchTransportOptions
): ClientTransport {
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
  const maxBatchSize = options?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
  assertValidWindowMs(windowMs)
  assertValidMaxBatchSize(maxBatchSize)

  let queue: QueuedCall[] = []
  let microtaskPending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearPendingTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const invokeTransport = (
    payload: JsonRpcSingleRequest | readonly JsonRpcSingleRequest[],
    sendOptions?: TransportSendOptions
  ): Promise<JsonRpcResponsePayload | void> => {
    try {
      return Promise.resolve(transport(payload, sendOptions))
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  const flush = (): void => {
    clearPendingTimer()
    if (queue.length === 0) {
      return
    }

    const batch = queue
    queue = []

    if (batch.length === 1) {
      const single = batch[0]!
      const sendOptions = single.signal ? { signal: single.signal } : undefined
      invokeTransport(single.payload, sendOptions).then(
        (response) => {
          cleanupAbort(single)
          if (!single.settled) {
            single.settled = true
            single.resolve(response)
          }
        },
        (reason) => {
          cleanupAbort(single)
          if (!single.settled) {
            single.settled = true
            single.reject(reason)
          }
        }
      )
      return
    }

    const payloads: JsonRpcSingleRequest[] = new Array(batch.length)
    let requestCount = 0
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i]!
      payloads[i] = entry.payload
      if (hasRequestId(entry.payload)) {
        requestCount++
      }
    }

    invokeTransport(payloads).then(
      (rawResponse) => {
        for (const entry of batch) {
          cleanupAbort(entry)
        }

        if (isJsonRpcErrorResponse(rawResponse)) {
          const error = new KrpcTransportError(
            `JSON-RPC batch error (${rawResponse.error.code}): ${rawResponse.error.message}`
          )
          for (const entry of batch) {
            if (!entry.settled) {
              entry.settled = true
              entry.reject(error)
            }
          }
          return
        }

        if (requestCount === 0) {
          for (const entry of batch) {
            if (!entry.settled) {
              entry.settled = true
              entry.resolve(undefined)
            }
          }
          return
        }

        if (!Array.isArray(rawResponse)) {
          const error = new KrpcTransportError(
            'Expected JSON-RPC batch response array for batch request'
          )
          for (const entry of batch) {
            if (entry.settled) {
              continue
            }
            entry.settled = true
            if (hasRequestId(entry.payload)) {
              entry.reject(error)
            } else {
              entry.resolve(undefined)
            }
          }
          return
        }

        const responsesById = new Map<JsonRpcId, JsonRpcResponse>()
        const duplicateIds = new Set<JsonRpcId>()
        for (const item of rawResponse) {
          if (!isJsonRpcResponse(item)) {
            continue
          }
          if (responsesById.has(item.id)) {
            duplicateIds.add(item.id)
          } else {
            responsesById.set(item.id, item)
          }
        }

        for (const entry of batch) {
          if (entry.settled) {
            continue
          }
          entry.settled = true

          if (!hasRequestId(entry.payload)) {
            entry.resolve(undefined)
            continue
          }

          const id = entry.payload.id
          if (duplicateIds.has(id)) {
            entry.reject(
              new KrpcTransportError(
                `Duplicate JSON-RPC response id in batch: ${String(id)}`
              )
            )
            continue
          }

          const response = responsesById.get(id)
          if (response === undefined) {
            entry.reject(
              new KrpcTransportError(
                `Missing JSON-RPC response for id ${String(id)}`
              )
            )
            continue
          }

          entry.resolve(response)
        }
      },
      (reason) => {
        for (const entry of batch) {
          cleanupAbort(entry)
          if (!entry.settled) {
            entry.settled = true
            entry.reject(reason)
          }
        }
      }
    )
  }

  const scheduleFlush = (): void => {
    if (windowMs === 0) {
      if (microtaskPending) {
        return
      }
      microtaskPending = true
      queueMicrotask(() => {
        microtaskPending = false
        flush()
      })
      return
    }
    if (timer === undefined) {
      timer = setTimeout(flush, windowMs)
    }
  }

  return (payload, sendOptions) => {
    if (Array.isArray(payload)) {
      return transport(payload, sendOptions)
    }

    const signal = sendOptions?.signal
    if (signal?.aborted) {
      return Promise.reject(getAbortReason(signal))
    }

    const singlePayload = payload as JsonRpcSingleRequest

    return new Promise<JsonRpcResponsePayload | void>((resolve, reject) => {
      const entry: QueuedCall = {
        payload: singlePayload,
        signal,
        resolve,
        reject,
        settled: false,
      }

      if (signal) {
        const onAbort = (): void => {
          const idx = queue.indexOf(entry)
          if (idx !== -1) {
            queue.splice(idx, 1)
            if (queue.length === 0) {
              clearPendingTimer()
            }
          }
          entry.onAbort = undefined
          if (!entry.settled) {
            entry.settled = true
            entry.reject(getAbortReason(signal))
          }
        }
        entry.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }

      queue.push(entry)

      if (queue.length >= maxBatchSize) {
        flush()
      } else {
        scheduleFlush()
      }
    })
  }
}
