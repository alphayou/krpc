/**
 * WebSocket duplex transport (`wsTransport` and `createWsServerTransport`) for `krpc`.
 *
 * @module krpc/ws
 */

export {
  createWsServerTransport,
  wsTransport,
  type ServerWebSocketLike,
  type WebSocketLike,
  type WsMessageData,
  type WsServerTransportBridge,
} from './transports/ws'
export type { DuplexTransport } from './transports/types'
