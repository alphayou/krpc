/**
 * Fetch-based HTTP transport (`httpTransport` and `createHttpHandler`) for `krpc`.
 *
 * @module @alphayou/krpc/http
 */

export {
  createHttpHandler,
  httpTransport,
  type FetchLike,
  type HttpCredentials,
  type HttpHandlerOptions,
  type HttpHeadersInit,
  type HttpHeadersInput,
  type HttpTransportOptions,
} from './transports/http'
export type { ClientTransport, TransportSendOptions } from './transports/types'
