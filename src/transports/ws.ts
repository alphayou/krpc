import { KrpcTransportError } from '../protocol/errors'
import type { RpcServer, ServerConnection } from '../server/server'
import type { RpcContext } from '../service/context'
import type { ServiceTree } from '../service/service'
import type { DuplexTransport } from './types'

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3

let textDecoder: TextDecoder | undefined

function getTextDecoder(): TextDecoder {
  return (textDecoder ??= new TextDecoder())
}

/** Supported inbound WebSocket frame payloads. */
export type WsMessageData = string | ArrayBuffer | ArrayBufferView

/** Minimal standard Web `WebSocket` shape accepted by `wsTransport`. */
export interface WebSocketLike {
  /** Current connection state (`0` CONNECTING, `1` OPEN, `2` CLOSING, `3` CLOSED). */
  readonly readyState: number
  /** Transmit a UTF-8 text frame over the socket. */
  send(data: string): void
  /** Initiate closing the WebSocket connection. */
  close(code?: number, reason?: string): void
  /** Register an event listener for `open`, `message`, or `close`. */
  addEventListener(type: string, listener: (event: any) => void): void
  /** Remove a previously registered event listener. */
  removeEventListener(type: string, listener: (event: any) => void): void
}

/** Minimal server-side socket shape (e.g. Bun `ServerWebSocket`) accepted by `createWsServerTransport`. */
export interface ServerWebSocketLike {
  /** Transmit a UTF-8 text frame to the connected client. */
  send(data: string): unknown
  /** Close the server-side socket connection. */
  close(code?: number, reason?: string): unknown
}

/** Bridge returned by `createWsServerTransport` for centralized-callback WebSocket servers. */
export interface WsServerTransportBridge {
  /** `DuplexTransport` instance to pass to `createPeer` or `server.connect`. */
  readonly transport: DuplexTransport
  /** Forward an inbound frame from the server's `message` callback. */
  handleMessage(data: WsMessageData): void
  /** Forward socket closure from the server's `close` callback. */
  handleClose(reason?: unknown): void
}

/** Configuration options for `createWsHandler`. */
export interface WsHandlerOptions<
  S extends ServiceTree = ServiceTree,
  WS extends ServerWebSocketLike = ServerWebSocketLike,
> {
  /** Derive a connection ID exposed on `ctx.clientId` and targeted by `server.notify` (auto-generated if omitted). */
  readonly id?: (ws: WS) => string | undefined
  /** Populate request-scoped context tokens for every inbound RPC invocation on this socket. */
  readonly setupContext?: (ctx: RpcContext, ws: WS) => void | Promise<void>
  /** Invoked after a socket opens and is registered on the `RpcServer`. */
  readonly onOpen?: (conn: ServerConnection<S>, ws: WS) => void
  /** Invoked once when a socket closes (either by the peer or via `conn.close()`). */
  readonly onClose?: (
    conn: ServerConnection<S>,
    ws: WS,
    reason?: unknown
  ) => void
}

/** Callback handler returned by `createWsHandler`, compatible with `Bun.serve({ websocket })`. */
export interface WsHandler<
  WS extends ServerWebSocketLike = ServerWebSocketLike,
> {
  /** Handle a newly opened server-side WebSocket connection. */
  open(ws: WS): void
  /** Forward an inbound WebSocket frame to the connected `RpcServer`. */
  message(ws: WS, data: WsMessageData): void
  /** Handle WebSocket closure and clean up its `RpcServer` registration. */
  close(ws: WS, code?: number, reason?: string): void
}

interface PendingSend {
  readonly message: string
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

function decodeWsMessage(data: WsMessageData): string {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return getTextDecoder().decode(data)
  }
  return getTextDecoder().decode(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  )
}

/**
 * Adapt a standard Web `WebSocket` into a `DuplexTransport`.
 *
 * Outbound messages sent while `readyState === 0` (`CONNECTING`) are queued and
 * flushed on `open`, or rejected if the socket closes before opening.
 */
export function wsTransport(socket: WebSocketLike): DuplexTransport {
  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()
  const pendingSends: PendingSend[] = []

  let closed =
    socket.readyState === WS_CLOSING || socket.readyState === WS_CLOSED
  let closeReason: unknown

  const emitMessage = (message: string): void => {
    if (closed) {
      return
    }
    for (const handler of messageHandlers) {
      handler(message)
    }
  }

  const cleanupListeners = (): void => {
    socket.removeEventListener('open', onOpen)
    socket.removeEventListener('message', onMessageEvent)
    socket.removeEventListener('close', onCloseEvent)
  }

  const emitClose = (reason?: unknown): void => {
    if (closed) {
      return
    }
    closed = true
    closeReason = reason
    cleanupListeners()

    const pending = pendingSends.splice(0, pendingSends.length)
    for (const item of pending) {
      item.reject(
        new KrpcTransportError('WebSocket closed before opening', {
          cause: reason,
        })
      )
    }

    const handlers = [...closeHandlers]
    closeHandlers.clear()
    messageHandlers.clear()
    for (const handler of handlers) {
      handler(reason)
    }
  }

  const onOpen = (): void => {
    if (closed) {
      return
    }
    const pending = pendingSends.splice(0, pendingSends.length)
    for (const item of pending) {
      try {
        socket.send(item.message)
        item.resolve()
      } catch (cause) {
        item.reject(
          new KrpcTransportError('Failed to send WebSocket message', { cause })
        )
      }
    }
  }

  const onMessageEvent = (event: { data?: unknown }): void => {
    if (closed) {
      return
    }
    const data = event?.data
    if (
      typeof data === 'string' ||
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data)
    ) {
      emitMessage(decodeWsMessage(data))
      return
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.text().then(emitMessage, () => {})
    }
  }

  const onCloseEvent = (event: unknown): void => {
    emitClose(event)
  }

  if (!closed) {
    socket.addEventListener('open', onOpen)
    socket.addEventListener('message', onMessageEvent)
    socket.addEventListener('close', onCloseEvent)
  }

  return {
    send(message: string): Promise<void> {
      if (
        closed ||
        socket.readyState === WS_CLOSING ||
        socket.readyState === WS_CLOSED
      ) {
        return Promise.reject(new KrpcTransportError('WebSocket is closed'))
      }

      if (socket.readyState === WS_CONNECTING) {
        return new Promise<void>((resolve, reject) => {
          pendingSends.push({ message, resolve, reject })
        })
      }

      if (socket.readyState !== WS_OPEN) {
        return Promise.reject(
          new KrpcTransportError(
            `WebSocket is not open (readyState=${socket.readyState})`
          )
        )
      }

      try {
        socket.send(message)
        return Promise.resolve()
      } catch (cause) {
        return Promise.reject(
          new KrpcTransportError('Failed to send WebSocket message', { cause })
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
      if (
        socket.readyState === WS_CONNECTING ||
        socket.readyState === WS_OPEN
      ) {
        socket.close()
      }
    },
  }
}

/**
 * Create a lightweight `DuplexTransport` bridge for centralized-callback server
 * WebSockets (such as `Bun.serve({ websocket: { open, message, close } })`).
 */
export function createWsServerTransport(
  ws: ServerWebSocketLike
): WsServerTransportBridge {
  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()

  let closed = false
  let closeReason: unknown

  const emitClose = (reason?: unknown): void => {
    if (closed) {
      return
    }
    closed = true
    closeReason = reason
    const handlers = [...closeHandlers]
    closeHandlers.clear()
    messageHandlers.clear()
    for (const handler of handlers) {
      handler(reason)
    }
  }

  const transport: DuplexTransport = {
    send(message: string): Promise<void> {
      if (closed) {
        return Promise.reject(new KrpcTransportError('WebSocket is closed'))
      }
      try {
        ws.send(message)
        return Promise.resolve()
      } catch (cause) {
        return Promise.reject(
          new KrpcTransportError('Failed to send WebSocket message', { cause })
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
      ws.close()
    },
  }

  return {
    transport,
    handleMessage(data: WsMessageData): void {
      if (closed) {
        return
      }
      const message = decodeWsMessage(data)
      for (const handler of messageHandlers) {
        handler(message)
      }
    },
    handleClose(reason?: unknown): void {
      emitClose(reason)
    },
  }
}

/**
 * Create a centralized-callback WebSocket handler (`{ open, message, close }`)
 * wired directly to an `RpcServer` via `server.connect`.
 *
 * Compatible with `Bun.serve({ websocket })` and any callback-based WebSocket server.
 */
export function createWsHandler<
  S extends ServiceTree,
  WS extends ServerWebSocketLike = ServerWebSocketLike,
>(server: RpcServer<S>, options?: WsHandlerOptions<S, WS>): WsHandler<WS> {
  const connections = new WeakMap<
    object,
    {
      readonly bridge: WsServerTransportBridge
      readonly conn: ServerConnection<S>
    }
  >()
  const resolveId = options?.id
  const setupContext = options?.setupContext
  const onOpen = options?.onOpen
  const onClose = options?.onClose

  return {
    open(ws: WS): void {
      const bridge = createWsServerTransport(ws)
      const conn = server.connect(bridge.transport, {
        id: resolveId?.(ws),
        setupContext: setupContext ? (ctx) => setupContext(ctx, ws) : undefined,
      })
      connections.set(ws, { bridge, conn })
      bridge.transport.onClose((reason) => {
        connections.delete(ws)
        onClose?.(conn, ws, reason)
      })
      onOpen?.(conn, ws)
    },

    message(ws: WS, data: WsMessageData): void {
      connections.get(ws)?.bridge.handleMessage(data)
    },

    close(ws: WS, code?: number, reason?: string): void {
      const entry = connections.get(ws)
      if (!entry) {
        return
      }
      const closeReason =
        code !== undefined || reason !== undefined
          ? { code, reason }
          : undefined
      entry.bridge.handleClose(closeReason)
    },
  }
}
