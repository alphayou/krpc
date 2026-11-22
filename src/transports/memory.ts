import { KrpcTransportError } from '../protocol/errors'
import type { RpcServer } from '../server/server'
import type { RpcContext } from '../service/context'
import type { ClientTransport, DuplexTransport } from './types'

/** Configuration options for `createMemoryTransport`. */
export interface MemoryTransportOptions {
  /** Populate request-scoped context tokens before hooks and handlers run. */
  readonly setupContext?: (ctx: RpcContext) => void | Promise<void>
}

interface MemoryEndpointState {
  readonly messageHandlers: Set<(message: string) => void>
  readonly closeHandlers: Set<(reason?: unknown) => void>
  closed: boolean
  closeReason: unknown
}

function createAbortError(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError')
  )
}

/**
 * Create an in-memory `ClientTransport` wired directly to an `RpcServer`.
 * Executes requests with zero network or serialization overhead.
 */
export function createMemoryTransport(
  server: RpcServer<any>,
  options?: MemoryTransportOptions
): ClientTransport {
  const setupContext = options?.setupContext

  return (payload, sendOptions) => {
    const signal = sendOptions?.signal
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal))
    }
    if (!signal && !setupContext) {
      return server.handle(payload)
    }
    return server.handle(payload, { signal, setupContext })
  }
}

/**
 * Create a connected pair of in-memory `DuplexTransport` endpoints.
 * Messages are delivered asynchronously via microtasks; closing either side closes both.
 */
export function createMemoryDuplexPair(): [DuplexTransport, DuplexTransport] {
  const stateA: MemoryEndpointState = {
    messageHandlers: new Set(),
    closeHandlers: new Set(),
    closed: false,
    closeReason: undefined,
  }
  const stateB: MemoryEndpointState = {
    messageHandlers: new Set(),
    closeHandlers: new Set(),
    closed: false,
    closeReason: undefined,
  }

  const closePair = (reason?: unknown): void => {
    if (stateA.closed && stateB.closed) {
      return
    }
    const closeHandlersA = stateA.closed ? [] : [...stateA.closeHandlers]
    const closeHandlersB = stateB.closed ? [] : [...stateB.closeHandlers]

    stateA.closed = true
    stateA.closeReason = reason
    stateA.closeHandlers.clear()
    stateA.messageHandlers.clear()

    stateB.closed = true
    stateB.closeReason = reason
    stateB.closeHandlers.clear()
    stateB.messageHandlers.clear()

    for (const handler of closeHandlersA) {
      handler(reason)
    }
    for (const handler of closeHandlersB) {
      handler(reason)
    }
  }

  const createEndpoint = (
    self: MemoryEndpointState,
    peer: MemoryEndpointState
  ): DuplexTransport => ({
    send(message: string): Promise<void> {
      if (self.closed) {
        return Promise.reject(
          new KrpcTransportError('Memory transport is closed')
        )
      }
      queueMicrotask(() => {
        if (peer.closed) {
          return
        }
        for (const handler of peer.messageHandlers) {
          handler(message)
        }
      })
      return Promise.resolve()
    },

    onMessage(handler: (message: string) => void): () => void {
      if (self.closed) {
        return () => {}
      }
      self.messageHandlers.add(handler)
      return () => {
        self.messageHandlers.delete(handler)
      }
    },

    onClose(handler: (reason?: unknown) => void): () => void {
      if (self.closed) {
        let active = true
        queueMicrotask(() => {
          if (active) {
            handler(self.closeReason)
          }
        })
        return () => {
          active = false
        }
      }
      self.closeHandlers.add(handler)
      return () => {
        self.closeHandlers.delete(handler)
      }
    },

    close(): void {
      closePair()
    },
  })

  return [createEndpoint(stateA, stateB), createEndpoint(stateB, stateA)]
}
