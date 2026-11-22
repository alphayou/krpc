/** JSON-RPC protocol version literal. */
export type JsonRpcVersion = '2.0'

/** Valid JSON-RPC 2.0 request/response identifier. */
export type JsonRpcId = string | number | null

/** Valid JSON-RPC 2.0 structured parameters (by-name object or by-position array). */
export type JsonRpcParams = Record<string, unknown> | readonly unknown[]

/** JSON-RPC 2.0 Request object (includes `id` and expects a response). */
export interface JsonRpcRequest<
  Method extends string = string,
  Params extends JsonRpcParams = JsonRpcParams,
> {
  /** Protocol version string, always `"2.0"`. */
  readonly jsonrpc: JsonRpcVersion
  /** Request identifier mirrored in the response. */
  readonly id: JsonRpcId
  /** Name of the RPC method to invoke. */
  readonly method: Method
  /** Optional structured parameters for the invocation. */
  readonly params?: Params
}

/** JSON-RPC 2.0 Notification object (omits `id` and must not receive a response). */
export interface JsonRpcNotification<
  Method extends string = string,
  Params extends JsonRpcParams = JsonRpcParams,
> {
  /** Protocol version string, always `"2.0"`. */
  readonly jsonrpc: JsonRpcVersion
  /** Must be absent on Notifications. */
  readonly id?: never
  /** Name of the RPC method or outbound notification. */
  readonly method: Method
  /** Optional structured parameters for the notification. */
  readonly params?: Params
}

/** A single outbound or inbound JSON-RPC 2.0 call (Request or Notification). */
export type JsonRpcSingleRequest = JsonRpcRequest | JsonRpcNotification

/** A JSON-RPC 2.0 request payload (single message or batch array). */
export type JsonRpcRequestPayload =
  JsonRpcSingleRequest | readonly JsonRpcSingleRequest[]

/** JSON-RPC 2.0 Error object carried inside an error response. */
export interface JsonRpcErrorObject<
  Code extends number = number,
  Data = unknown,
> {
  /** Integer indicating the error type that occurred. */
  readonly code: Code
  /** Short human-readable error description. */
  readonly message: string
  /** Optional additional error details. */
  readonly data?: Data
}

/** JSON-RPC 2.0 Success Response object. */
export interface JsonRpcSuccessResponse<ResultValue = unknown> {
  /** Protocol version string, always `"2.0"`. */
  readonly jsonrpc: JsonRpcVersion
  /** Identifier matching the originating Request. */
  readonly id: JsonRpcId
  /** Value returned by the invoked method. */
  readonly result: ResultValue
  /** Must be absent on Success Responses. */
  readonly error?: never
}

/** JSON-RPC 2.0 Error Response object. */
export interface JsonRpcErrorResponse<
  Code extends number = number,
  Data = unknown,
> {
  /** Protocol version string, always `"2.0"`. */
  readonly jsonrpc: JsonRpcVersion
  /** Identifier matching the originating Request, or `null` if undetectable. */
  readonly id: JsonRpcId
  /** Structured JSON-RPC 2.0 error object. */
  readonly error: JsonRpcErrorObject<Code, Data>
  /** Must be absent on Error Responses. */
  readonly result?: never
}

/** A single JSON-RPC 2.0 Response object (success or error). */
export type JsonRpcResponse<
  ResultValue = unknown,
  Code extends number = number,
  Data = unknown,
> = JsonRpcSuccessResponse<ResultValue> | JsonRpcErrorResponse<Code, Data>

/** A JSON-RPC 2.0 response payload (single response or batch array). */
export type JsonRpcResponsePayload =
  JsonRpcResponse | readonly JsonRpcResponse[]

/** Any valid JSON-RPC 2.0 wire payload. */
export type JsonRpcPayload = JsonRpcRequestPayload | JsonRpcResponsePayload

/** Standard reserved JSON-RPC 2.0 error codes. */
export const JSON_RPC_ERROR_CODES = {
  /** Invalid JSON was received by the server (`-32700`). */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object (`-32600`). */
  INVALID_REQUEST: -32600,
  /** The method does not exist or is not available (`-32601`). */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s) (`-32602`). */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error (`-32603`). */
  INTERNAL_ERROR: -32603,
} as const

/** Union of standard reserved JSON-RPC 2.0 error codes. */
export type StandardJsonRpcErrorCode =
  (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES]

/** Standard JSON-RPC 2.0 protocol error shape returned on client failure. */
export type StandardRpcError =
  | {
      /** Parse error code (`-32700`). */
      readonly code: typeof JSON_RPC_ERROR_CODES.PARSE_ERROR
      /** Error description. */
      readonly message: string
      /** Optional error details. */
      readonly data?: unknown
    }
  | {
      /** Invalid Request error code (`-32600`). */
      readonly code: typeof JSON_RPC_ERROR_CODES.INVALID_REQUEST
      /** Error description. */
      readonly message: string
      /** Optional error details. */
      readonly data?: unknown
    }
  | {
      /** Method not found error code (`-32601`). */
      readonly code: typeof JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND
      /** Error description. */
      readonly message: string
      /** Optional error details. */
      readonly data?: unknown
    }
  | {
      /** Invalid params error code (`-32602`). */
      readonly code: typeof JSON_RPC_ERROR_CODES.INVALID_PARAMS
      /** Error description. */
      readonly message: string
      /** Optional error details. */
      readonly data?: unknown
    }
  | {
      /** Internal error code (`-32603`). */
      readonly code: typeof JSON_RPC_ERROR_CODES.INTERNAL_ERROR
      /** Error description. */
      readonly message: string
      /** Optional error details. */
      readonly data?: unknown
    }

/** Discriminated union representing either a successful value or a typed error. */
export type Result<T, E = StandardRpcError> =
  | {
      /** Indicates a successful result. */
      readonly ok: true
      /** Resolved success value. */
      readonly value: T
    }
  | {
      /** Indicates a failed result. */
      readonly ok: false
      /** Structured RPC error. */
      readonly error: E
    }

/** Construct a successful `Result`. */
export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

/** Construct a failed `Result`. */
export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error }
}
