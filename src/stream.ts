/**
 * Framed Web Streams duplex transport (`streamTransport`) and NDJSON / Content-Length helpers for `krpc`.
 *
 * @module @alphayou-ai/krpc/stream
 */

export {
  createContentLengthDecoder,
  createNdjsonDecoder,
  encodeContentLengthFrame,
  encodeNdjsonFrame,
  streamTransport,
  type FrameDecoder,
  type StreamFraming,
  type StreamTransportOptions,
} from './transports/stream'
export type { DuplexTransport } from './transports/types'
