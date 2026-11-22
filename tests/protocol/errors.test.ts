import { describe, expect, it } from 'bun:test'
import {
  defineError,
  internalError,
  invalidParams,
  invalidRequest,
  isJsonRpcError,
  isRpcErrorValue,
  JsonRpcError,
  KrpcTimeoutError,
  KrpcTransportError,
  methodNotFound,
  parseError,
  RPC_ERROR_BRAND,
  serverError,
  type RpcErrorValue,
} from '../../src/protocol/errors'
import {
  err,
  JSON_RPC_ERROR_CODES,
  ok,
  type Result,
  type StandardRpcError,
} from '../../src/protocol/types'

describe('Result helpers', () => {
  it('constructs ok and err values', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 })
    expect(err({ code: -32601 as const, message: 'Method not found' })).toEqual(
      {
        ok: false,
        error: { code: -32601, message: 'Method not found' },
      }
    )
  })
})

describe('JsonRpcError and standard factories', () => {
  it('constructs JsonRpcError with and without data', () => {
    const simple = new JsonRpcError(-32001, 'Unauthorized')
    expect(simple).toBeInstanceOf(Error)
    expect(simple).toBeInstanceOf(JsonRpcError)
    expect(simple.name).toBe('JsonRpcError')
    expect(simple.code).toBe(-32001)
    expect(simple.message).toBe('Unauthorized')
    expect(simple.data).toBeUndefined()
    expect('data' in simple.toJSON()).toBe(false)
    expect(simple.toJSON()).toEqual({ code: -32001, message: 'Unauthorized' })
    expect(isJsonRpcError(simple)).toBe(true)
    expect(isJsonRpcError(new Error('plain'))).toBe(false)
    expect(isJsonRpcError({ code: -32001, message: 'Unauthorized' })).toBe(
      false
    )

    const cause = new Error('root')
    const withData = new JsonRpcError(
      -32003,
      'Overflow',
      { max: 100 },
      { cause }
    )
    expect(withData.data).toEqual({ max: 100 })
    expect(withData.cause).toBe(cause)
    expect(withData.toJSON()).toEqual({
      code: -32003,
      message: 'Overflow',
      data: { max: 100 },
    })
  })

  it('preserves falsy data values in toJSON', () => {
    for (const falsy of [0, false, '', null]) {
      const e = new JsonRpcError(-32000, 'Falsy', falsy)
      expect(e.toJSON()).toEqual({
        code: -32000,
        message: 'Falsy',
        data: falsy,
      })
    }
  })

  it('creates standard JSON-RPC 2.0 protocol errors', () => {
    expect(parseError().toJSON()).toEqual({
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: 'Parse error',
    })
    expect(invalidRequest('Bad batch').toJSON()).toEqual({
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Bad batch',
    })
    expect(methodNotFound('No such method', { method: 'x' }).toJSON()).toEqual({
      code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
      message: 'No such method',
      data: { method: 'x' },
    })
    expect(invalidParams().toJSON()).toEqual({
      code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      message: 'Invalid params',
    })
    expect(internalError().toJSON()).toEqual({
      code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
    })
  })

  it('validates serverError code range (-32099..-32000)', () => {
    expect(serverError().toJSON()).toEqual({
      code: -32000,
      message: 'Server error',
    })
    expect(
      serverError(-32099, 'Overloaded', { retryAfter: 5 }).toJSON()
    ).toEqual({
      code: -32099,
      message: 'Overloaded',
      data: { retryAfter: 5 },
    })

    expect(() => serverError(-32100)).toThrow(RangeError)
    expect(() => serverError(-31999)).toThrow(RangeError)
    expect(() => serverError(-32600)).toThrow(RangeError)
    expect(() => serverError(-32000.5)).toThrow(RangeError)
    expect(() => serverError(Number.NaN)).toThrow(RangeError)
  })
})

describe('KrpcTransportError and KrpcTimeoutError', () => {
  it('constructs KrpcTransportError with optional HTTP status and cause', () => {
    const cause = new Error('ECONNREFUSED')
    const errWithStatus = new KrpcTransportError('HTTP 503', {
      status: 503,
      cause,
    })
    expect(errWithStatus).toBeInstanceOf(Error)
    expect(errWithStatus).toBeInstanceOf(KrpcTransportError)
    expect(errWithStatus.name).toBe('KrpcTransportError')
    expect(errWithStatus.message).toBe('HTTP 503')
    expect(errWithStatus.status).toBe(503)
    expect(errWithStatus.cause).toBe(cause)

    const errPlain = new KrpcTransportError('Socket closed')
    expect(errPlain.status).toBeUndefined()
  })

  it('constructs KrpcTimeoutError with default and custom messages', () => {
    const defaultTimeout = new KrpcTimeoutError(5000)
    expect(defaultTimeout).toBeInstanceOf(Error)
    expect(defaultTimeout).toBeInstanceOf(KrpcTimeoutError)
    expect(defaultTimeout.name).toBe('KrpcTimeoutError')
    expect(defaultTimeout.timeoutMs).toBe(5000)
    expect(defaultTimeout.message).toBe('RPC request timed out after 5000ms')

    const customTimeout = new KrpcTimeoutError(1000, 'Custom deadline')
    expect(customTimeout.timeoutMs).toBe(1000)
    expect(customTimeout.message).toBe('Custom deadline')
  })
})

describe('defineError and isRpcErrorValue', () => {
  const Unauthorized = defineError(-32001, 'Unauthorized')
  const DivByZero = defineError(-32002, 'Division by zero')
  const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()
  const QuotaExceeded = defineError(-32004, 'Quota exceeded').data<{
    limit: number
  }>()
  const StringData = defineError(-32011, 'Invalid field').data<string>()

  it('exposes literal .code and .defaultMessage metadata', () => {
    const c1: -32001 = Unauthorized.code
    const c3: -32003 = Overflow.code
    const c4: -32004 = QuotaExceeded.code
    expect(c1).toBe(-32001)
    expect(Unauthorized.defaultMessage).toBe('Unauthorized')
    expect(c3).toBe(-32003)
    expect(Overflow.defaultMessage).toBe('Overflow')
    expect(c4).toBe(-32004)
    expect(QuotaExceeded.defaultMessage).toBe('Quota exceeded')
  })

  it('creates branded data-less error values with default or custom message', () => {
    const e1 = Unauthorized()
    expect(e1[RPC_ERROR_BRAND]).toBe(true)
    expect(e1.code).toBe(-32001)
    expect(e1.message).toBe('Unauthorized')
    expect('data' in e1).toBe(false)
    expect(isRpcErrorValue(e1)).toBe(true)

    const e2 = Unauthorized('Token expired')
    expect(e2.code).toBe(-32001)
    expect(e2.message).toBe('Token expired')
    expect('data' in e2).toBe(false)

    const e3 = Unauthorized(undefined)
    expect(e3.message).toBe('Unauthorized')
    expect('data' in e3).toBe(false)
  })

  it('creates branded typed-data error values including string and falsy payloads', () => {
    const e1 = Overflow({ max: 1e9 })
    expect(e1[RPC_ERROR_BRAND]).toBe(true)
    expect(e1.code).toBe(-32003)
    expect(e1.message).toBe('Overflow')
    expect(e1.data).toEqual({ max: 1e9 })
    expect(isRpcErrorValue(e1)).toBe(true)

    const e2 = Overflow({ max: 10 }, 'Value exceeds limit')
    expect(e2.code).toBe(-32003)
    expect(e2.message).toBe('Value exceeds limit')
    expect(e2.data).toEqual({ max: 10 })

    const e3 = StringData('field_x')
    expect(e3.code).toBe(-32011)
    expect(e3.message).toBe('Invalid field')
    expect(e3.data).toBe('field_x')

    const e4 = StringData('field_y', 'Custom message')
    expect(e4.message).toBe('Custom message')
    expect(e4.data).toBe('field_y')

    const FalsyData = defineError(-32010, 'Falsy').data<number | null>()
    expect(FalsyData(0).data).toBe(0)
    expect(FalsyData(null).data).toBeNull()
  })

  it('matches RpcErrorValue, JsonRpcError, and plain client error objects via .is()', () => {
    const branded = Overflow({ max: 100 })
    const thrown = new JsonRpcError(-32003, 'Overflow', { max: 100 })
    const plain = { code: -32003, message: 'Overflow', data: { max: 100 } }

    expect(Overflow.is(branded)).toBe(true)
    expect(Overflow.is(thrown)).toBe(true)
    expect(Overflow.is(plain)).toBe(true)

    expect(Unauthorized.is(branded)).toBe(false)
    expect(Overflow.is(DivByZero())).toBe(false)
    expect(Overflow.is({ code: -32003 })).toBe(false)
    expect(Overflow.is({ code: -32003, message: 123 })).toBe(false)
    expect(Overflow.is(null)).toBe(false)
    expect(Overflow.is(undefined)).toBe(false)
    expect(Overflow.is(-32003)).toBe(false)
    expect(Overflow.is('Overflow')).toBe(false)
  })

  it('distinguishes branded RpcErrorValue from unbranded objects in isRpcErrorValue()', () => {
    expect(isRpcErrorValue(Unauthorized())).toBe(true)
    expect(isRpcErrorValue(Overflow({ max: 1 }))).toBe(true)
    expect(isRpcErrorValue(new JsonRpcError(-32001, 'Unauthorized'))).toBe(
      false
    )
    expect(isRpcErrorValue({ code: -32001, message: 'Unauthorized' })).toBe(
      false
    )
    expect(isRpcErrorValue(null)).toBe(false)
    expect(isRpcErrorValue('error')).toBe(false)
  })

  it('narrows discriminated unions derived from ReturnType and rejects reserved codes at compile time', () => {
    type StripBrand<T> = Omit<T, typeof RPC_ERROR_BRAND>
    type MultiError =
      | StripBrand<ReturnType<typeof DivByZero>>
      | StripBrand<ReturnType<typeof Overflow>>
      | StripBrand<ReturnType<typeof QuotaExceeded>>
      | StandardRpcError

    const failure: Result<number, MultiError> = err({
      code: -32003,
      message: 'Overflow',
      data: { max: 1e9 },
    })

    if (!failure.ok && failure.error.code === -32003) {
      const max: number = failure.error.data.max
      expect(max).toBe(1e9)
    }

    if (!failure.ok && failure.error.code === -32004) {
      const limit: number = failure.error.data.limit
      expect(limit).toBeDefined()
    }

    if (!failure.ok && Overflow.is(failure.error)) {
      const max: number = failure.error.data.max
      expect(max).toBe(1e9)
    }

    type HandlerReturn =
      number | ReturnType<typeof DivByZero> | ReturnType<typeof Overflow>
    type SuccessPart = Exclude<HandlerReturn, RpcErrorValue>
    type ErrorPart = Extract<HandlerReturn, RpcErrorValue>
    const s: SuccessPart = 123
    const e: ErrorPart = DivByZero()
    expect(s).toBe(123)
    expect(e.code).toBe(-32002)

    const _compileTimeAssertions = () => {
      // @ts-expect-error -32700 is a reserved JSON-RPC 2.0 error code
      defineError(-32700, 'Parse error')
      // @ts-expect-error -32600 is a reserved JSON-RPC 2.0 error code
      defineError(-32600, 'Invalid Request')
      // @ts-expect-error -32601 is a reserved JSON-RPC 2.0 error code
      defineError(-32601, 'Method not found')
      // @ts-expect-error -32602 is a reserved JSON-RPC 2.0 error code
      defineError(-32602, 'Invalid params')
      // @ts-expect-error -32603 is a reserved JSON-RPC 2.0 error code
      defineError(-32603, 'Internal error')
      // @ts-expect-error reserved code is rejected before .data<T>() too
      defineError(-32600, 'Reserved').data<{ detail: string }>()

      // @ts-expect-error Overflow requires data argument
      Overflow()
      // @ts-expect-error Overflow validates data shape
      Overflow({ max: 'not-a-number' })
      // @ts-expect-error Unauthorized does not accept object argument
      Unauthorized({ unexpected: true })
    }
    expect(typeof _compileTimeAssertions).toBe('function')
  })
})
