import { KrpcTransportError } from '../protocol/errors'
import type { DuplexTransport } from './types'

let textDecoder: TextDecoder | undefined

function getTextDecoder(): TextDecoder {
  return (textDecoder ??= new TextDecoder())
}

/**
 * Minimal Web Standard `MessagePort`, `Worker`, or `DedicatedWorkerGlobalScope`
 * shape accepted by `portTransport`.
 */
export interface MessagePortLike {
  /** Post a message payload to the remote endpoint. */
  postMessage(message: unknown): void
  /** Register an event listener for `message` (and optional `close`) events. */
  addEventListener(type: string, listener: (event: any) => void): void
  /** Remove a previously registered event listener. */
  removeEventListener(type: string, listener: (event: any) => void): void
  /** Start dispatching queued messages (`MessagePort` requires this with `addEventListener`). */
  start?(): void
  /** Close the port and release underlying resources, if supported. */
  close?(): void
}

function decodePortMessage(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data
  }
  if (data === undefined) {
    return undefined
  }
  if (data instanceof ArrayBuffer) {
    return getTextDecoder().decode(data)
  }
  if (ArrayBuffer.isView(data)) {
    return getTextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    )
  }
  try {
    return JSON.stringify(data)
  } catch {
    return undefined
  }
}

/**
 * Adapt a Web Standard `MessagePort`, `Worker`, or `DedicatedWorkerGlobalScope`
 * into a `DuplexTransport`.
 *
 * Calls `port.start?.()` automatically so queued `MessagePort` messages begin
 * flowing immediately when using `addEventListener`, accepts both string and
 * structured inbound payloads, unsubscribes cleanly on `close()`, and invokes
 * `onClose` handlers idempotently.
 */
export function portTransport(port: MessagePortLike): DuplexTransport {
  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()

  let closed = false
  let closeReason: unknown

  const cleanupListeners = (): void => {
    port.removeEventListener('message', onMessageEvent)
    port.removeEventListener('close', onCloseEvent)
  }

  const emitClose = (reason?: unknown): void => {
    if (closed) {
      return
    }
    closed = true
    closeReason = reason
    cleanupListeners()

    const handlers = [...closeHandlers]
    closeHandlers.clear()
    messageHandlers.clear()
    for (const handler of handlers) {
      try {
        handler(reason)
      } catch {
        // Isolate close listener exceptions from port cleanup.
      }
    }
  }

  const onMessageEvent = (event: { data?: unknown }): void => {
    if (closed) {
      return
    }
    const message = decodePortMessage(event?.data)
    if (message === undefined) {
      return
    }
    for (const handler of [...messageHandlers]) {
      try {
        handler(message)
      } catch {
        // Isolate listener exceptions so sibling listeners still receive frames.
      }
    }
  }

  const onCloseEvent = (event: unknown): void => {
    emitClose(event)
  }

  port.addEventListener('message', onMessageEvent)
  port.addEventListener('close', onCloseEvent)
  port.start?.()

  return {
    send(message: string): Promise<void> {
      if (closed) {
        return Promise.reject(
          new KrpcTransportError('Port transport is closed')
        )
      }
      try {
        port.postMessage(message)
        return Promise.resolve()
      } catch (cause) {
        return Promise.reject(
          new KrpcTransportError('Failed to send message over port', { cause })
        )
      }
    },

    onMessage(handler: (message: string) => void): () => void {
      if (closed) {
        return () => {}
      }
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },

    onClose(handler: (reason?: unknown) => void): () => void {
      if (closed) {
        let active = true
        queueMicrotask(() => {
          if (active) {
            handler(closeReason)
          }
        })
        return () => {
          active = false
        }
      }
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },

    close(): void {
      if (closed) {
        return
      }
      emitClose()
      port.close?.()
    },
  }
}
