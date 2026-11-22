/**
 * Framed stdio and subprocess pipe duplex transport (`stdioTransport`) for `krpc`.
 *
 * @module krpc/stdio
 */

export {
  stdioTransport,
  type StdioReadableLike,
  type StdioTransportOptions,
  type StdioWritableLike,
} from './transports/stdio'
export type { StreamFraming } from './transports/stream'
export type { DuplexTransport } from './transports/types'
