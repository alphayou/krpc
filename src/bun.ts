/**
 * Unified HTTP + WebSocket `Bun.serve` adapter (`createBunHandler`) for `krpc`.
 *
 * Uses pure structural TypeScript types with zero Bun-only runtime imports.
 *
 * @module @alphayou/krpc/bun
 */

export {
  createBunHandler,
  type BunHandler,
  type BunHandlerOptions,
  type BunServerLike,
  type BunWebSocketData,
  type BunWebSocketLike,
} from './transports/bun'
