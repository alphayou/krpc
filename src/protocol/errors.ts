import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcErrorObject,
  type JsonRpcResponse,
  type JsonRpcResponsePayload,
  type StandardJsonRpcErrorCode,
} from './types'

/** Runtime JSON-RPC 2.0 error class suitable for throwing inside handlers or hooks. */
export class JsonRpcError extends Error {
  /** Error class name. */
  override readonly name: string = 'JsonRpcError'
  /** Integer JSON-RPC 2.0 error code. */
  readonly code: number
  /** Optional structured error data. */
  readonly data?: unknown

  constructor(
    code: number,
    message: string,
    data?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.code = code
    if (data !== undefined) {
      this.data = data
    }
  }

  /** Serialize into a wire-compliant JSON-RPC 2.0 error object. */
  toJSON(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data }
  }
}

/** Runtime type guard for `JsonRpcError` instances. */
export function isJsonRpcError(value: unknown): value is JsonRpcError {
  return value instanceof JsonRpcError
}

/** Create a `-32700 Parse error` JSON-RPC error. */
export function parseError(
  message = 'Parse error',
  data?: unknown
): JsonRpcError {
  return new JsonRpcError(JSON_RPC_ERROR_CODES.PARSE_ERROR, message, data)
}

/** Create a `-32600 Invalid Request` JSON-RPC error. */
export function invalidRequest(
  message = 'Invalid Request',
  data?: unknown
): JsonRpcError {
  return new JsonRpcError(JSON_RPC_ERROR_CODES.INVALID_REQUEST, message, data)
}

/** Create a `-32601 Method not found` JSON-RPC error. */
export function methodNotFound(
  message = 'Method not found',
  data?: unknown
): JsonRpcError {
  return new JsonRpcError(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, message, data)
}

/** Create a `-32602 Invalid params` JSON-RPC error. */
export function invalidParams(
  message = 'Invalid params',
  data?: unknown
): JsonRpcError {
  return new JsonRpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, message, data)
}

/** Create a `-32603 Internal error` JSON-RPC error. */
export function internalError(
  message = 'Internal error',
  data?: unknown
): JsonRpcError {
  return new JsonRpcError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message, data)
}

/** Create a JSON-RPC 2.0 implementation-defined server error (`-32099` to `-32000`). */
export function serverError(
  code = -32000,
  message = 'Server error',
  data?: unknown
): JsonRpcError {
  if (!Number.isInteger(code) || code < -32099 || code > -32000) {
    throw new RangeError(
      `Server error code must be an integer between -32099 and -32000, received ${code}`
    )
  }
  return new JsonRpcError(code, message, data)
}

/** Options for constructing a `KrpcTransportError`. */
export interface KrpcTransportErrorOptions extends ErrorOptions {
  /** Optional HTTP status code associated with the transport failure. */
  readonly status?: number
}

/** Infrastructure error thrown when transport delivery or wire framing fails. */
export class KrpcTransportError extends Error {
  /** Error class name. */
  override readonly name: string = 'KrpcTransportError'
  /** Optional HTTP status code associated with the transport failure. */
  readonly status?: number

  constructor(message: string, options?: KrpcTransportErrorOptions) {
    super(message, options)
    if (options?.status !== undefined) {
      this.status = options.status
    }
  }
}

/** Infrastructure error thrown when a client request exceeds its configured timeout. */
export class KrpcTimeoutError extends Error {
  /** Error class name. */
  override readonly name: string = 'KrpcTimeoutError'
  /** Configured timeout duration in milliseconds. */
  readonly timeoutMs: number

  constructor(
    timeoutMs: number,
    message = `RPC request timed out after ${timeoutMs}ms`,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.timeoutMs = timeoutMs
  }
}

/** Unique symbol branding domain error return values created by `defineError`. */
export const RPC_ERROR_BRAND: unique symbol =
  /*#__PURE__*/ Symbol.for('krpc.error')

/**
 * Compile-time guard rejecting reserved standard JSON-RPC 2.0 error codes
 * (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`) in custom `defineError` definitions.
 */
export type ValidateCustomErrorCode<Code extends number> =
  Code extends StandardJsonRpcErrorCode ? never : Code

/** Plain error shape surfaced on clients and matched by error factory `.is()` guards. */
export type RpcErrorObject<
  Code extends number = number,
  Data = unknown,
> = unknown extends Data
  ? {
      /** Integer JSON-RPC error code. */
      readonly code: Code
      /** Human-readable error message. */
      readonly message: string
      /** Optional structured error data. */
      readonly data?: Data
    }
  : [Data] extends [undefined]
    ? {
        /** Integer JSON-RPC error code. */
        readonly code: Code
        /** Human-readable error message. */
        readonly message: string
        /** Unused on data-less errors. */
        readonly data?: undefined
      }
    : {
        /** Integer JSON-RPC error code. */
        readonly code: Code
        /** Human-readable error message. */
        readonly message: string
        /** Structured error payload. */
        readonly data: Data
      }

/** Branded error value returned from RPC handlers and `onBefore` hooks. */
export type RpcErrorValue<Code extends number = number, Data = unknown> = {
  /** Internal brand identifying a `defineError` return value. */
  readonly [RPC_ERROR_BRAND]: true
} & RpcErrorObject<Code, Data>

/** Callable typed-data error factory returned by `defineError(...).data<Data>()`. */
export interface RpcDataErrorFactory<Code extends number, Data> {
  /** Create a branded error value carrying typed `data` and an optional custom `message`. */
  (data: Data, message?: string): RpcErrorValue<Code, Data>
  /** Literal JSON-RPC error code. */
  readonly code: Code
  /** Default error message used when no override is passed. */
  readonly defaultMessage: string
  /** Type guard matching `RpcErrorValue`, `JsonRpcError`, and plain client error objects. */
  readonly is: (value: unknown) => value is RpcErrorObject<Code, Data>
}

/** Callable data-less error factory returned by `defineError(code, defaultMessage)`. */
export interface RpcErrorFactory<Code extends number = number> {
  /** Create a branded data-less error value with an optional custom `message`. */
  (message?: string): RpcErrorValue<Code, undefined>
  /** Literal JSON-RPC error code. */
  readonly code: Code
  /** Default error message used when no override is passed. */
  readonly defaultMessage: string
  /** Type guard matching `RpcErrorValue`, `JsonRpcError`, and plain client error objects. */
  readonly is: (value: unknown) => value is RpcErrorObject<Code, undefined>
  /** Specialize this error definition to carry a strongly typed `data` payload. */
  readonly data: <Data>() => RpcDataErrorFactory<Code, Data>
}

function createErrorMatcher<Code extends number, Data>(
  code: Code
): (value: unknown) => value is RpcErrorObject<Code, Data> {
  return (value: unknown): value is RpcErrorObject<Code, Data> => {
    if (typeof value !== 'object' || value === null) {
      return false
    }
    const candidate = value as Record<string, unknown>
    return candidate.code === code && typeof candidate.message === 'string'
  }
}

/**
 * Define a typed domain RPC error.
 * Standard JSON-RPC 2.0 error codes (`-32700`..`-32603`) are rejected at compile time.
 * Chain `.data<T>()` to require a typed `data` payload while preserving the literal error code.
 */
export function defineError<const Code extends number>(
  code: ValidateCustomErrorCode<Code>,
  defaultMessage: string
): RpcErrorFactory<Code> {
  const is = createErrorMatcher<Code, undefined>(code)

  const factory = (message?: string): RpcErrorValue<Code, undefined> => ({
    [RPC_ERROR_BRAND]: true,
    code,
    message: message ?? defaultMessage,
  })

  const withData = <Data>(): RpcDataErrorFactory<Code, Data> => {
    const dataFactory = (
      data: Data,
      message?: string
    ): RpcErrorValue<Code, Data> =>
      ({
        [RPC_ERROR_BRAND]: true,
        code,
        message: message ?? defaultMessage,
        data,
      }) as RpcErrorValue<Code, Data>

    return Object.assign(dataFactory, {
      code,
      defaultMessage,
      is: createErrorMatcher<Code, Data>(code),
    })
  }

  return Object.assign(factory, {
    code,
    defaultMessage,
    is,
    data: withData,
  })
}

/** Runtime type guard for branded `RpcErrorValue` objects created by `defineError`. */
export function isRpcErrorValue(value: unknown): value is RpcErrorValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<PropertyKey, unknown>
  return (
    candidate[RPC_ERROR_BRAND] === true &&
    typeof candidate.code === 'number' &&
    typeof candidate.message === 'string'
  )
}

/**
 * @internal Safely serialize a JSON-RPC 2.0 response or batch response.
 * Falls back to `-32603 Internal error` per unserializable response item so
 * wire adapters never crash or silently drop replies.
 */
export function stringifyJsonRpcResponse(
  payload: JsonRpcResponsePayload
): string {
  try {
    return JSON.stringify(payload)
  } catch {
    const fallback = internalError().toJSON()
    if (Array.isArray(payload)) {
      const items: string[] = new Array(payload.length)
      for (let i = 0; i < payload.length; i++) {
        const entry = payload[i] as JsonRpcResponse
        try {
          items[i] = JSON.stringify(entry)
        } catch {
          items[i] = JSON.stringify({
            jsonrpc: '2.0',
            id: entry.id,
            error: fallback,
          })
        }
      }
      return `[${items.join(',')}]`
    }
    const single = payload as JsonRpcResponse
    return JSON.stringify({
      jsonrpc: '2.0',
      id: single.id,
      error: fallback,
    })
  }
}
