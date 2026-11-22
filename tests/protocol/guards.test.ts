import { describe, expect, it } from 'bun:test'
import {
  isJsonRpcErrorObject,
  isJsonRpcErrorResponse,
  isJsonRpcId,
  isJsonRpcNotification,
  isJsonRpcParams,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  isPlainObject,
  isReservedRpcMethod,
  parseJsonRpcPayload,
} from '../../src/protocol/guards'
import {
  isStandardSchema,
  validateStandardSchema,
  type InferInput,
  type InferOutput,
  type StandardSchemaV1,
} from '../../src/protocol/standard-schema'
import { JSON_RPC_ERROR_CODES } from '../../src/protocol/types'

describe('isPlainObject', () => {
  it('accepts plain objects and null-prototype objects', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('rejects primitives, arrays, functions, and built-in/class instances', () => {
    class Custom {
      x = 1
    }

    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(undefined)).toBe(false)
    expect(isPlainObject('str')).toBe(false)
    expect(isPlainObject(42)).toBe(false)
    expect(isPlainObject(true)).toBe(false)
    expect(isPlainObject(Symbol('s'))).toBe(false)
    expect(isPlainObject(10n)).toBe(false)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(() => {})).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(/abc/)).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
    expect(isPlainObject(new Set())).toBe(false)
    expect(isPlainObject(new Error('boom'))).toBe(false)
    expect(isPlainObject(new Custom())).toBe(false)
  })
})

describe('isJsonRpcParams', () => {
  it('accepts structured params (plain objects and arrays)', () => {
    expect(isJsonRpcParams({})).toBe(true)
    expect(isJsonRpcParams({ a: 1, b: 'two' })).toBe(true)
    expect(isJsonRpcParams(Object.create(null))).toBe(true)
    expect(isJsonRpcParams([])).toBe(true)
    expect(isJsonRpcParams([1, 'two', null])).toBe(true)
  })

  it('rejects primitives, null, undefined, and non-plain objects', () => {
    expect(isJsonRpcParams(null)).toBe(false)
    expect(isJsonRpcParams(undefined)).toBe(false)
    expect(isJsonRpcParams(0)).toBe(false)
    expect(isJsonRpcParams(123)).toBe(false)
    expect(isJsonRpcParams('')).toBe(false)
    expect(isJsonRpcParams('hello')).toBe(false)
    expect(isJsonRpcParams(true)).toBe(false)
    expect(isJsonRpcParams(false)).toBe(false)
    expect(isJsonRpcParams(new Date())).toBe(false)
    expect(isJsonRpcParams(new Map())).toBe(false)
  })
})

describe('isJsonRpcId', () => {
  it('accepts strings, finite numbers, and null', () => {
    expect(isJsonRpcId('req-1')).toBe(true)
    expect(isJsonRpcId('')).toBe(true)
    expect(isJsonRpcId(0)).toBe(true)
    expect(isJsonRpcId(1)).toBe(true)
    expect(isJsonRpcId(-42)).toBe(true)
    expect(isJsonRpcId(1.5)).toBe(true)
    expect(isJsonRpcId(null)).toBe(true)
  })

  it('rejects NaN, Infinity, booleans, objects, arrays, and undefined', () => {
    expect(isJsonRpcId(undefined)).toBe(false)
    expect(isJsonRpcId(Number.NaN)).toBe(false)
    expect(isJsonRpcId(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isJsonRpcId(Number.NEGATIVE_INFINITY)).toBe(false)
    expect(isJsonRpcId(true)).toBe(false)
    expect(isJsonRpcId(false)).toBe(false)
    expect(isJsonRpcId({})).toBe(false)
    expect(isJsonRpcId([])).toBe(false)
    expect(isJsonRpcId(Symbol('id'))).toBe(false)
    expect(isJsonRpcId(1n)).toBe(false)
  })
})

describe('isJsonRpcErrorObject', () => {
  it('accepts valid error objects with integer code and string message', () => {
    expect(
      isJsonRpcErrorObject({ code: -32600, message: 'Invalid Request' })
    ).toBe(true)
    expect(
      isJsonRpcErrorObject({ code: 0, message: '', data: { detail: true } })
    ).toBe(true)
    expect(
      isJsonRpcErrorObject({ code: -32001, message: 'Custom', data: null })
    ).toBe(true)
  })

  it('rejects non-integer codes, missing/non-string messages, and non-objects', () => {
    expect(isJsonRpcErrorObject(null)).toBe(false)
    expect(isJsonRpcErrorObject([])).toBe(false)
    expect(isJsonRpcErrorObject({ code: 1.5, message: 'Fractional' })).toBe(
      false
    )
    expect(
      isJsonRpcErrorObject({ code: Number.NaN, message: 'NaN code' })
    ).toBe(false)
    expect(isJsonRpcErrorObject({ code: '-32600', message: 'String' })).toBe(
      false
    )
    expect(isJsonRpcErrorObject({ code: -32600 })).toBe(false)
    expect(isJsonRpcErrorObject({ code: -32600, message: 123 })).toBe(false)
  })
})

describe('isJsonRpcRequest and isJsonRpcNotification', () => {
  it('accepts valid requests with string, numeric, or null id', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(
      true
    )
    expect(
      isJsonRpcRequest({ jsonrpc: '2.0', id: 0, method: 'ping', params: [] })
    ).toBe(true)
    expect(
      isJsonRpcRequest({
        jsonrpc: '2.0',
        id: 'abc',
        method: 'math.add',
        params: { a: 1, b: 2 },
      })
    ).toBe(true)
    expect(
      isJsonRpcRequest({
        jsonrpc: '2.0',
        id: null,
        method: 'ping',
      })
    ).toBe(true)
    expect(
      isJsonRpcRequest({
        jsonrpc: '2.0',
        id: 1,
        method: '',
        params: undefined,
      })
    ).toBe(true)
  })

  it('distinguishes missing id (Notification) from id: null (Request)', () => {
    const notification = { jsonrpc: '2.0', method: 'log', params: { msg: 'a' } }
    const nullIdRequest = { jsonrpc: '2.0', id: null, method: 'log' }

    expect(isJsonRpcNotification(notification)).toBe(true)
    expect(isJsonRpcRequest(notification)).toBe(false)

    expect(isJsonRpcRequest(nullIdRequest)).toBe(true)
    expect(isJsonRpcNotification(nullIdRequest)).toBe(false)
  })

  it('treats explicit id: undefined as a Notification, not a Request', () => {
    const msg = { jsonrpc: '2.0', id: undefined, method: 'log' }
    expect(isJsonRpcNotification(msg)).toBe(true)
    expect(isJsonRpcRequest(msg)).toBe(false)
  })

  it('rejects primitive params on both Requests and Notifications', () => {
    for (const badParams of [null, 0, 42, '', 'hello', true, false]) {
      const req = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
        params: badParams,
      }
      const notif = {
        jsonrpc: '2.0',
        method: 'test',
        params: badParams,
      }
      expect(isJsonRpcRequest(req)).toBe(false)
      expect(isJsonRpcNotification(notif)).toBe(false)
    }
  })

  it('rejects invalid version, method, id, or non-object values', () => {
    const invalidMessages: unknown[] = [
      null,
      undefined,
      'string',
      [],
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { jsonrpc: 2.0, id: 1, method: 'ping' },
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, method: 123 },
      { jsonrpc: '2.0', id: true, method: 'ping' },
      { jsonrpc: '2.0', id: {}, method: 'ping' },
      { jsonrpc: '2.0', id: [], method: 'ping' },
      { jsonrpc: '2.0', id: Number.NaN, method: 'ping' },
      { jsonrpc: '2.0', id: Number.POSITIVE_INFINITY, method: 'ping' },
      { jsonrpc: '1.0', method: 'notify' },
      { jsonrpc: '2.0', method: null },
    ]

    for (const msg of invalidMessages) {
      expect(isJsonRpcRequest(msg)).toBe(false)
      expect(isJsonRpcNotification(msg)).toBe(false)
    }
  })
})

describe('isJsonRpcResponse, isJsonRpcSuccessResponse, isJsonRpcErrorResponse', () => {
  it('accepts valid success responses including falsy and null results', () => {
    const valid = [
      { jsonrpc: '2.0', id: 1, result: 42 },
      { jsonrpc: '2.0', id: 'abc', result: null },
      { jsonrpc: '2.0', id: 0, result: false },
      { jsonrpc: '2.0', id: '', result: '' },
      { jsonrpc: '2.0', id: null, result: 0 },
      { jsonrpc: '2.0', id: 1, result: undefined },
    ]

    for (const res of valid) {
      expect(isJsonRpcSuccessResponse(res)).toBe(true)
      expect(isJsonRpcErrorResponse(res)).toBe(false)
      expect(isJsonRpcResponse(res)).toBe(true)
    }
  })

  it('accepts valid error responses including null id and optional data', () => {
    const valid = [
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      },
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      {
        jsonrpc: '2.0',
        id: '1',
        error: { code: -32003, message: 'Overflow', data: { max: 100 } },
      },
    ]

    for (const res of valid) {
      expect(isJsonRpcErrorResponse(res)).toBe(true)
      expect(isJsonRpcSuccessResponse(res)).toBe(false)
      expect(isJsonRpcResponse(res)).toBe(true)
    }
  })

  it('rejects responses with neither result nor error, or with both', () => {
    const invalid: unknown[] = [
      null,
      [],
      { jsonrpc: '2.0', id: 1 },
      {
        jsonrpc: '2.0',
        id: 1,
        result: 1,
        error: { code: -32600, message: 'Both' },
      },
      { jsonrpc: '2.0', id: 1, result: 1, error: null },
      { jsonrpc: '2.0', id: 1, result: 1, error: undefined },
      {
        jsonrpc: '2.0',
        id: 1,
        result: null,
        error: { code: -32600, message: 'Both' },
      },
      { jsonrpc: '2.0', result: 1 },
      { jsonrpc: '2.0', error: { code: -32700, message: 'Missing id' } },
      { jsonrpc: '2.0', id: true, result: 1 },
      { jsonrpc: '2.0', id: Number.NaN, result: 1 },
      { jsonrpc: '1.0', id: 1, result: 1 },
      { jsonrpc: '2.0', id: 1, error: { code: 1.5, message: 'Float code' } },
      { jsonrpc: '2.0', id: 1, error: { code: -32600 } },
      { jsonrpc: '2.0', id: 1, error: null },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]

    for (const res of invalid) {
      expect(isJsonRpcSuccessResponse(res)).toBe(false)
      expect(isJsonRpcErrorResponse(res)).toBe(false)
      expect(isJsonRpcResponse(res)).toBe(false)
    }
  })
})

describe('isReservedRpcMethod', () => {
  it('matches methods beginning with the rpc. prefix', () => {
    expect(isReservedRpcMethod('rpc.discover')).toBe(true)
    expect(isReservedRpcMethod('rpc.')).toBe(true)
    expect(isReservedRpcMethod('rpc.internal.stats')).toBe(true)
  })

  it('does not match non-reserved method names', () => {
    expect(isReservedRpcMethod('rpc')).toBe(false)
    expect(isReservedRpcMethod('rpcMethod')).toBe(false)
    expect(isReservedRpcMethod('service.rpc.call')).toBe(false)
    expect(isReservedRpcMethod('RPC.discover')).toBe(false)
    expect(isReservedRpcMethod('')).toBe(false)
  })
})

describe('parseJsonRpcPayload', () => {
  it('parses valid single object and non-empty batch payloads', () => {
    const single = parseJsonRpcPayload(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}'
    )
    expect(single.ok).toBe(true)
    if (single.ok) {
      expect(single.value).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' })
    }

    const batch = parseJsonRpcPayload(
      '[{"jsonrpc":"2.0","id":1,"method":"ping"}, 123]'
    )
    expect(batch.ok).toBe(true)
    if (batch.ok) {
      expect(batch.value).toEqual([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        123,
      ])
    }
  })

  it('returns -32700 Parse error on invalid JSON', () => {
    for (const raw of ['', '{invalid', '[1, 2,', 'undefined']) {
      const result = parseJsonRpcPayload(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR)
        expect(result.error.message).toBe('Parse error')
      }
    }
  })

  it('returns -32600 Invalid Request on empty batch or top-level primitives', () => {
    for (const raw of ['[]', 'null', '42', '"hello"', 'true', 'false']) {
      const result = parseJsonRpcPayload(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST)
        expect(result.error.message).toBe('Invalid Request')
      }
    }
  })
})

describe('standard-schema helpers', () => {
  const numericObjectSchema: StandardSchemaV1<
    { a: number; b?: number },
    { a: number; b: number }
  > = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value) {
        if (!isPlainObject(value) || typeof value.a !== 'number') {
          return {
            issues: [
              {
                message: 'Expected number',
                path: [{ key: 'a' }],
              },
            ],
          }
        }
        return {
          value: {
            a: value.a,
            b: typeof value.b === 'number' ? value.b : 10,
          },
        }
      },
    },
  }

  it('detects Standard Schema v1 objects and callable validators', () => {
    expect(isStandardSchema(numericObjectSchema)).toBe(true)

    const callableSchema = Object.assign(() => {}, {
      '~standard': {
        version: 1,
        vendor: 'callable',
        validate: (v: unknown) => ({ value: v }),
      },
    })
    expect(isStandardSchema(callableSchema)).toBe(true)

    expect(isStandardSchema(null)).toBe(false)
    expect(isStandardSchema({})).toBe(false)
    expect(isStandardSchema({ '~standard': null })).toBe(false)
    expect(
      isStandardSchema({
        '~standard': { version: 2, vendor: 'future', validate: () => {} },
      })
    ).toBe(false)
    expect(
      isStandardSchema({
        '~standard': { version: 1, vendor: 123, validate: () => {} },
      })
    ).toBe(false)
    expect(
      isStandardSchema({
        '~standard': { version: 1, vendor: 'bad', validate: 'not-a-fn' },
      })
    ).toBe(false)
  })

  it('validates sync schemas and normalizes issue paths', async () => {
    const okResult = await validateStandardSchema(numericObjectSchema, { a: 5 })
    expect(okResult).toEqual({ ok: true, value: { a: 5, b: 10 } })

    const failResult = await validateStandardSchema(numericObjectSchema, {
      a: 'bad',
    })
    expect(failResult).toEqual({
      ok: false,
      issues: [{ message: 'Expected number', path: ['a'] }],
    })

    // Type-level check: Input keeps `b` optional while Output makes `b` required.
    type In = InferInput<typeof numericObjectSchema>
    type Out = InferOutput<typeof numericObjectSchema>
    const inputSample: In = { a: 1 }
    const outputSample: Out = { a: 1, b: 2 }
    expect(inputSample.a).toBe(1)
    expect(outputSample.b).toBe(2)
  })

  it('validates async schemas and normalizes symbol/empty paths', async () => {
    const sym = Symbol('secret')
    const asyncSchema: StandardSchemaV1<string, string> = {
      '~standard': {
        version: 1,
        vendor: 'async-test',
        async validate(value) {
          if (typeof value === 'string') {
            return { value: value.trim() }
          }
          return {
            issues: [
              { message: 'Root failure', path: [] },
              { message: 'Nested failure', path: ['items', 0, { key: sym }] },
              { message: 'No path failure' },
            ],
          }
        },
      },
    }

    expect(await validateStandardSchema(asyncSchema, '  hi  ')).toEqual({
      ok: true,
      value: 'hi',
    })

    expect(await validateStandardSchema(asyncSchema, 123)).toEqual({
      ok: false,
      issues: [
        { message: 'Root failure' },
        { message: 'Nested failure', path: ['items', 0, 'Symbol(secret)'] },
        { message: 'No path failure' },
      ],
    })
  })
})
