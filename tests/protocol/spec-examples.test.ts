import { describe, expect, it } from 'bun:test'
import { createServer } from '../../src/server/server'
import { defineMethod } from '../../src/service/method'
import { defineService } from '../../src/service/service'

/**
 * Verbatim test vectors from JSON-RPC 2.0 Specification Section 7 (Examples):
 * https://www.jsonrpc.org/specification#examples
 */
describe('JSON-RPC 2.0 Section 7 specification examples', () => {
  const notifications: Array<{ method: string; params: unknown }> = []

  const specService = defineService(() => {
    const subtract = defineMethod(
      (params: [number, number] | { minuend: number; subtrahend: number }) => {
        if (Array.isArray(params)) {
          return params[0] - params[1]
        }
        return params.minuend - params.subtrahend
      }
    )

    const sum = defineMethod((params: number[]) =>
      params.reduce((acc, n) => acc + n, 0)
    )

    const get_data = defineMethod(() => ['hello', 5])

    const update = defineMethod((params: number[]) => {
      notifications.push({ method: 'update', params })
    })

    const notify_hello = defineMethod((params: number[]) => {
      notifications.push({ method: 'notify_hello', params })
    })

    const notify_sum = defineMethod((params: number[]) => {
      notifications.push({ method: 'notify_sum', params })
    })

    return {
      subtract,
      sum,
      get_data,
      update,
      notify_hello,
      notify_sum,
    }
  })

  const server = createServer(specService)

  async function sendRaw(raw: string): Promise<unknown> {
    const response = await server.handleRaw(raw)
    if (response === undefined) {
      return undefined
    }
    return JSON.parse(JSON.stringify(response))
  }

  it('rpc call with positional parameters', async () => {
    expect(
      await sendRaw(
        '{"jsonrpc": "2.0", "method": "subtract", "params": [42, 23], "id": 1}'
      )
    ).toEqual({ jsonrpc: '2.0', result: 19, id: 1 })

    expect(
      await sendRaw(
        '{"jsonrpc": "2.0", "method": "subtract", "params": [23, 42], "id": 2}'
      )
    ).toEqual({ jsonrpc: '2.0', result: -19, id: 2 })
  })

  it('rpc call with named parameters', async () => {
    expect(
      await sendRaw(
        '{"jsonrpc": "2.0", "method": "subtract", "params": {"subtrahend": 23, "minuend": 42}, "id": 3}'
      )
    ).toEqual({ jsonrpc: '2.0', result: 19, id: 3 })

    expect(
      await sendRaw(
        '{"jsonrpc": "2.0", "method": "subtract", "params": {"minuend": 42, "subtrahend": 23}, "id": 4}'
      )
    ).toEqual({ jsonrpc: '2.0', result: 19, id: 4 })
  })

  it('a Notification', async () => {
    notifications.length = 0

    expect(
      await sendRaw(
        '{"jsonrpc": "2.0", "method": "update", "params": [1,2,3,4,5]}'
      )
    ).toBeUndefined()

    expect(
      await sendRaw('{"jsonrpc": "2.0", "method": "foobar"}')
    ).toBeUndefined()

    expect(notifications).toEqual([
      { method: 'update', params: [1, 2, 3, 4, 5] },
    ])
  })

  it('rpc call of non-existent method', async () => {
    expect(
      await sendRaw('{"jsonrpc": "2.0", "method": "foobar", "id": "1"}')
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: '1',
    })
  })

  it('rpc call with invalid JSON', async () => {
    expect(
      await sendRaw(
        '{"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]'
      )
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    })
  })

  it('rpc call with invalid Request object', async () => {
    expect(
      await sendRaw('{"jsonrpc": "2.0", "method": 1, "params": "bar"}')
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: null,
    })
  })

  it('rpc call Batch, invalid JSON', async () => {
    expect(
      await sendRaw(`[
        {"jsonrpc": "2.0", "method": "sum", "params": [1,2,4], "id": "1"},
        {"jsonrpc": "2.0", "method"
      ]`)
    ).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    })
  })

  it('rpc call with an empty Array', async () => {
    expect(await sendRaw('[]')).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: null,
    })
  })

  it('rpc call with an invalid Batch (but not empty)', async () => {
    expect(await sendRaw('[1]')).toEqual([
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      },
    ])
  })

  it('rpc call with invalid Batch', async () => {
    expect(await sendRaw('[1,2,3]')).toEqual([
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      },
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      },
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      },
    ])
  })

  it('rpc call Batch (mixed valid, notification, invalid, not-found)', async () => {
    notifications.length = 0

    expect(
      await sendRaw(`[
        {"jsonrpc": "2.0", "method": "sum", "params": [1,2,4], "id": "1"},
        {"jsonrpc": "2.0", "method": "notify_hello", "params": [7]},
        {"jsonrpc": "2.0", "method": "subtract", "params": [42,23], "id": "2"},
        {"foo": "boo"},
        {"jsonrpc": "2.0", "method": "foo.get", "params": {"name": "myself"}, "id": "5"},
        {"jsonrpc": "2.0", "method": "get_data", "id": "9"}
      ]`)
    ).toEqual([
      { jsonrpc: '2.0', result: 7, id: '1' },
      { jsonrpc: '2.0', result: 19, id: '2' },
      {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      },
      {
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not found' },
        id: '5',
      },
      { jsonrpc: '2.0', result: ['hello', 5], id: '9' },
    ])

    expect(notifications).toEqual([{ method: 'notify_hello', params: [7] }])
  })

  it('rpc call Batch (all notifications)', async () => {
    notifications.length = 0

    expect(
      await sendRaw(`[
        {"jsonrpc": "2.0", "method": "notify_sum", "params": [1,2,4]},
        {"jsonrpc": "2.0", "method": "notify_hello", "params": [7]}
      ]`)
    ).toBeUndefined()

    expect(notifications).toEqual([
      { method: 'notify_sum', params: [1, 2, 4] },
      { method: 'notify_hello', params: [7] },
    ])
  })
})
