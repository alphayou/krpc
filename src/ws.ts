/**
 * WebSocket duplex transport (`wsTransport`, `createWsServerTransport`, and `createWsHandler`) for `krpc`.
 *
 * @module @alphayou-ai/krpc/ws
 */

export {
  createWsHandler,
  createWsServerTransport,
  wsTransport,
  type ServerWebSocketLike,
  type WebSocketLike,
  type WsHandler,
  type WsHandlerOptions,
  type WsMessageData,
  type WsServerTransportBridge,
} from './transports/ws'
export type { DuplexTransport } from './transports/types'
