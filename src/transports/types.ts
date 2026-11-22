import type {
  JsonRpcRequestPayload,
  JsonRpcResponsePayload,
} from '../protocol/types'

/** Optional delivery settings for a single `ClientTransport` request. */
export interface TransportSendOptions {
  /** Signal used to cancel the outbound transport operation. */
  readonly signal?: AbortSignal
}

/** One-way request/response transport function (e.g. HTTP or in-memory). */
export type ClientTransport = (
  payload: JsonRpcRequestPayload,
  options?: TransportSendOptions
) => Promise<JsonRpcResponsePayload | void>

/** Bidirectional text-framed transport for full-duplex peers (e.g. WebSocket or streams). */
export interface DuplexTransport {
  /** Send a single serialized JSON-RPC message frame to the remote peer. */
  send(message: string): void | Promise<void>
  /** Subscribe to inbound message frames. Returns an unsubscribe function. */
  onMessage(handler: (message: string) => void): () => void
  /** Subscribe to transport closure. Returns an unsubscribe function. */
  onClose(handler: (reason?: unknown) => void): () => void
  /** Close the transport and release underlying resources. */
  close(): void | Promise<void>
}

/** Runtime type guard for `DuplexTransport` instances. */
export function isDuplexTransport(value: unknown): value is DuplexTransport {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.send === 'function' &&
    typeof candidate.onMessage === 'function' &&
    typeof candidate.onClose === 'function' &&
    typeof candidate.close === 'function'
  )
}
