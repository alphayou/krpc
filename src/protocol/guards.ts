import { invalidRequest, parseError, type JsonRpcError } from './errors'
import {
  err,
  ok,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type Result,
} from './types'

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** Runtime type guard for plain JavaScript objects (`{}` or `Object.create(null)`). */
export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Runtime type guard for JSON-RPC 2.0 structured `params`
 * (either a plain object or an array; primitives and `null` are rejected).
 */
export function isJsonRpcParams(value: unknown): value is JsonRpcParams {
  return Array.isArray(value) || isPlainObject(value)
}

/**
 * Runtime type guard for JSON-RPC 2.0 `id` values
 * (`string`, finite `number`, or `null`).
 */
export function isJsonRpcId(value: unknown): value is JsonRpcId {
  if (value === null || typeof value === 'string') {
    return true
  }
  return typeof value === 'number' && Number.isFinite(value)
}

/** Runtime type guard for JSON-RPC 2.0 error objects (`{ code, message, data? }`). */
export function isJsonRpcErrorObject(
  value: unknown
): value is JsonRpcErrorObject {
  if (!isPlainObject(value)) {
    return false
  }
  return (
    typeof value.code === 'number' &&
    Number.isInteger(value.code) &&
    typeof value.message === 'string'
  )
}

/**
 * Runtime type guard for JSON-RPC 2.0 Request objects.
 * Requires a valid `id` (including `id: null`); missing `id` is a Notification.
 */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isPlainObject(value)) {
    return false
  }
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    return false
  }
  if (
    !hasOwn(value, 'id') ||
    value.id === undefined ||
    !isJsonRpcId(value.id)
  ) {
    return false
  }
  if (value.params !== undefined && !isJsonRpcParams(value.params)) {
    return false
  }
  return true
}

/**
 * Runtime type guard for JSON-RPC 2.0 Notification objects.
 * Requires `id` to be absent (or `undefined`); `id: null` is a Request, not a Notification.
 */
export function isJsonRpcNotification(
  value: unknown
): value is JsonRpcNotification {
  if (!isPlainObject(value)) {
    return false
  }
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    return false
  }
  if (hasOwn(value, 'id') && value.id !== undefined) {
    return false
  }
  if (value.params !== undefined && !isJsonRpcParams(value.params)) {
    return false
  }
  return true
}

/** Runtime type guard for JSON-RPC 2.0 Success Response objects. */
export function isJsonRpcSuccessResponse(
  value: unknown
): value is JsonRpcSuccessResponse {
  if (!isPlainObject(value)) {
    return false
  }
  if (value.jsonrpc !== '2.0') {
    return false
  }
  if (!hasOwn(value, 'id') || !isJsonRpcId(value.id)) {
    return false
  }
  if (!hasOwn(value, 'result') || hasOwn(value, 'error')) {
    return false
  }
  return true
}

/** Runtime type guard for JSON-RPC 2.0 Error Response objects. */
export function isJsonRpcErrorResponse(
  value: unknown
): value is JsonRpcErrorResponse {
  if (!isPlainObject(value)) {
    return false
  }
  if (value.jsonrpc !== '2.0') {
    return false
  }
  if (!hasOwn(value, 'id') || !isJsonRpcId(value.id)) {
    return false
  }
  if (hasOwn(value, 'result') || !hasOwn(value, 'error')) {
    return false
  }
  return isJsonRpcErrorObject(value.error)
}

/** Runtime type guard for JSON-RPC 2.0 Response objects (success or error). */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isJsonRpcSuccessResponse(value) || isJsonRpcErrorResponse(value)
}

/**
 * Check whether a method name uses the JSON-RPC 2.0 reserved `rpc.` prefix.
 */
export function isReservedRpcMethod(method: string): boolean {
  return method.startsWith('rpc.')
}

/**
 * Parse a raw JSON string into a JSON-RPC 2.0 wire payload (single object or non-empty batch).
 * Returns `-32700 Parse error` on malformed JSON, and `-32600 Invalid Request` on
 * empty batch arrays (`[]`) or non-object/non-array top-level JSON values.
 */
export function parseJsonRpcPayload(
  raw: string
): Result<Record<string, unknown> | readonly unknown[], JsonRpcError> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return err(parseError())
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return err(invalidRequest())
    }
    return ok(parsed)
  }

  if (isPlainObject(parsed)) {
    return ok(parsed)
  }

  return err(invalidRequest())
}
