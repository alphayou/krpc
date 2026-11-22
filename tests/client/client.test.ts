import { describe, expect, it } from 'bun:test'
import { createClient } from '../../src/client/client'
import {
  defineError,
  KrpcTimeoutError,
  KrpcTransportError,
} from '../../src/protocol/errors'
import { isPlainObject } from '../../src/protocol/guards'
import type { StandardSchemaV1 } from '../../src/protocol/standard-schema'
import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcRequestPayload,
  type JsonRpcResponsePayload,
} from '../../src/protocol/types'
import { createServer } from '../../src/server/server'
import { defineMethod } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import type { ClientTransport } from '../../src/transports/types'

const DivByZero = defineError(-32002, 'Division by zero')
const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

const divideSchema: StandardSchemaV1<
  { a: number; b?: number },
  { a: number; b: number }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (!isPlainObject(value) || typeof value.a !== 'number') {
        return { issues: [{ message: 'Expected number', path: ['a'] }] }
      }
      return {
        value: { a: value.a, b: typeof value.b === 'number' ? value.b : 1 },
      }
    },
  },
}

const app = defineService(() => {
  const ping = defineMethod(() => 'pong' as const)
  const log = defineMethod(({ message }: { message: string }) => {
    void message
  })
  const opt = defineMethod((p?: { tag?: string }) => p?.tag ?? 'default')
  const setConfig = defineMethod(({ timeout }: { timeout: number }) => ({
    applied: timeout,
  }))
  const math = defineService(() => {
    const divide = defineMethod(divideSchema, ({ a, b }) => {
      if (b === 0) return DivByZero()
      if (a > 1000) return Overflow({ max: 1000 })
      return a / b
    })
    const sum = defineMethod(([a, b]: [number, number]) => a + b)
    return { divide, sum }
  })
  return { ping, log, opt, setConfig, math }
})

type App = typeof app

function mockTransportFromServer(): {
  transport: ClientTransport
  sent: JsonRpcRequestPayload[]
} {
  const server = createServer(app)
  const sent: JsonRpcRequestPayload[] = []
  const transport: ClientTransport = async (payload, options) => {
    sent.push(payload)
    return server.handle(payload, { signal: options?.signal })
  }
  return { transport, sent }
}

describe('createClient — call & notify', () => {
  it('invokes zero-arg, object, tuple, optional, and timeout-named param methods', async () => {
    const { transport, sent } = mockTransportFromServer()
    const client = createClient<App>(transport)

    const pong = await client.call('ping')
    expect(pong).toEqual({ ok: true, value: 'pong' })

    const sum = await client.call('math.sum', [4, 6])
    expect(sum).toEqual({ ok: true, value: 10 })

    const optDefault = await client.call('opt')
    expect(optDefault).toEqual({ ok: true, value: 'default' })

    const optTag = await client.call('opt', { tag: 'v2' })
    expect(optTag).toEqual({ ok: true, value: 'v2' })

    // Params object with a `timeout` field must NOT be mistaken for CallOptions
    const cfg = await client.call('setConfig', { timeout: 2500 })
    expect(cfg).toEqual({ ok: true, value: { applied: 2500 } })

    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(sent[4]).toEqual({
      jsonrpc: '2.0',
      id: 5,
      method: 'setConfig',
      params: { timeout: 2500 },
    })
  })

  it('returns typed Result errors (never throws) for domain and protocol errors', async () => {
    const { transport } = mockTransportFromServer()
    const client = createClient<App>(transport, { nextId: () => 'custom-id' })

    const divZero = await client.call('math.divide', { a: 10, b: 0 })
    expect(divZero.ok).toBe(false)
    if (!divZero.ok) {
      expect(DivByZero.is(divZero.error)).toBe(true)
      expect(divZero.error.code).toBe(-32002)
    }

    const overflow = await client.call('math.divide', { a: 5000, b: 2 })
    expect(overflow.ok).toBe(false)
    if (!overflow.ok && overflow.error.code === -32003) {
      expect(overflow.error.data.max).toBe(1000)
    }
    if (!overflow.ok && Overflow.is(overflow.error)) {
      expect(overflow.error.data.max).toBe(1000)
    }

    const invalid = await client.call('math.divide', {
      a: 'bad' as unknown as number,
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS)
    }
  })

  it('sends Notifications without id and supports custom signal/options', async () => {
    const { transport, sent } = mockTransportFromServer()
    const client = createClient<App>(transport)

    await client.notify('ping')
    await client.notify('log', { message: 'hello' })

    expect(sent).toEqual([
      { jsonrpc: '2.0', method: 'ping' },
      { jsonrpc: '2.0', method: 'log', params: { message: 'hello' } },
    ])
  })

  it('throws KrpcTransportError on invalid or mismatched responses', async () => {
    const undefinedTransport: ClientTransport = async () => undefined
    const c1 = createClient<App>(undefinedTransport)
    await expect(c1.call('ping')).rejects.toBeInstanceOf(KrpcTransportError)

    const mismatchTransport: ClientTransport = async () => ({
      jsonrpc: '2.0',
      id: 999,
      result: 'pong',
    })
    const c2 = createClient<App>(mismatchTransport)
    await expect(c2.call('ping')).rejects.toThrow(
      'Mismatched JSON-RPC response id'
    )
  })

  it('throws KrpcTimeoutError on default, per-call, and <=0 timeouts', async () => {
    const slowTransport: ClientTransport = async (_payload, opts) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 100)
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(opts.signal?.reason)
        })
      })
      return { jsonrpc: '2.0', id: 1, result: 'pong' }
    }

    const defaultTimeoutClient = createClient<App>(slowTransport, {
      timeout: 15,
    })
    await expect(defaultTimeoutClient.call('ping')).rejects.toBeInstanceOf(
      KrpcTimeoutError
    )

    const perCallClient = createClient<App>(slowTransport)
    await expect(
      perCallClient.call('ping', undefined, { timeout: 15 })
    ).rejects.toBeInstanceOf(KrpcTimeoutError)

    await expect(
      perCallClient.call('ping', undefined, { timeout: 0 })
    ).rejects.toBeInstanceOf(KrpcTimeoutError)
  })

  it('supports pre-aborted and mid-flight AbortSignal (with and without timeout)', async () => {
    let calls = 0
    const slowTransport: ClientTransport = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 100))
      return { jsonrpc: '2.0', id: 1, result: 'pong' }
    }
    const client = createClient<App>(slowTransport)

    const preAborted = new AbortController()
    preAborted.abort(new Error('cancelled-early'))
    await expect(
      client.call('ping', undefined, { signal: preAborted.signal })
    ).rejects.toThrow('cancelled-early')
    expect(calls).toBe(0)

    // Abort mid-flight without timeout
    const mid = new AbortController()
    setTimeout(() => mid.abort(), 10)
    await expect(
      client.call('ping', undefined, { signal: mid.signal })
    ).rejects.toThrow()

    // Abort mid-flight with timeout also configured
    const midWithTimeout = new AbortController()
    setTimeout(() => midWithTimeout.abort(new Error('user-cancel')), 10)
    await expect(
      client.call('ping', undefined, {
        timeout: 200,
        signal: midWithTimeout.signal,
      })
    ).rejects.toThrow('user-cancel')
  })

  it('handles falsy valid JsonRpcId values (0 and "") across single calls and batches', async () => {
    const server = createServer(app)
    const reverseTransport: ClientTransport = async (payload) => {
      const res = await server.handle(payload)
      return Array.isArray(res)
        ? ([...res].reverse() as JsonRpcResponsePayload)
        : res
    }

    const ids: Array<number | string> = [0, '', 0, '']
    let idx = 0
    const client = createClient<App>(reverseTransport, {
      nextId: () => ids[idx++]!,
    })

    expect(await client.call('ping')).toEqual({ ok: true, value: 'pong' })
    expect(await client.call('math.sum', [2, 3])).toEqual({
      ok: true,
      value: 5,
    })

    const [first, second] = await client.batch((b) => [
      b.call('math.divide', { a: 10, b: 0 }),
      b.call('math.sum', [7, 8]),
    ])
    expect(first).toEqual({
      ok: false,
      error: { code: -32002, message: 'Division by zero' },
    })
    expect(second).toEqual({ ok: true, value: 15 })
  })

  it('covers timeout success/failure, signal transport failure, and AbortSignal without reason', async () => {
    const { transport } = mockTransportFromServer()
    const timedClient = createClient<App>(transport, { timeout: 200 })
    expect(await timedClient.call('ping')).toEqual({ ok: true, value: 'pong' })

    const failingTransport: ClientTransport = async () => {
      throw new KrpcTransportError('boom')
    }
    const failingClient = createClient<App>(failingTransport)

    // Transport error with timeout configured (no timeout hit)
    await expect(
      failingClient.call('ping', undefined, { timeout: 200 })
    ).rejects.toThrow('boom')

    // Transport error with non-aborted signal (no timeout)
    const ac = new AbortController()
    await expect(
      failingClient.call('ping', undefined, { signal: ac.signal })
    ).rejects.toThrow('boom')

    // Transport rejects after external signal aborts (with and without timeout)
    const abortingTransport =
      (controller: AbortController): ClientTransport =>
      async () => {
        controller.abort(new Error('late-abort'))
        throw new Error('underlying-err')
      }
    const ac2 = new AbortController()
    await expect(
      createClient<App>(abortingTransport(ac2)).call('ping', undefined, {
        signal: ac2.signal,
      })
    ).rejects.toThrow('late-abort')

    const ac3 = new AbortController()
    await expect(
      createClient<App>(abortingTransport(ac3)).call('ping', undefined, {
        timeout: 200,
        signal: ac3.signal,
      })
    ).rejects.toThrow('late-abort')

    // AbortSignal with undefined reason falls back to standard AbortError DOMException
    const fakeSignal = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    let abortErr: unknown
    try {
      await timedClient.call('ping', undefined, { signal: fakeSignal })
    } catch (err) {
      abortErr = err
    }
    expect(abortErr).toBeInstanceOf(DOMException)
    expect((abortErr as DOMException).name).toBe('AbortError')
  })
})

describe('createClient — batch', () => {
  it('handles empty batch without invoking transport', async () => {
    let called = false
    const transport: ClientTransport = async () => {
      called = true
      return undefined
    }
    const client = createClient<App>(transport)

    const res = await client.batch(() => [])
    expect(res).toEqual([])
    expect(called).toBe(false)
  })

  it('handles mixed call + notify batches and out-of-order responses by id', async () => {
    const server = createServer(app)
    const reverseTransport: ClientTransport = async (payload) => {
      const res = await server.handle(payload)
      if (Array.isArray(res)) {
        return [...res].reverse() as JsonRpcResponsePayload
      }
      return res
    }

    const client = createClient<App>(reverseTransport)
    const [divOk, divErr, logSlot, sumOk] = await client.batch((b) => [
      b.call('math.divide', { a: 10, b: 2 }),
      b.call('math.divide', { a: 10, b: 0 }),
      b.notify('log', { message: 'done' }),
      b.call('math.sum', [3, 7]),
    ])

    expect(divOk).toEqual({ ok: true, value: 5 })
    expect(divErr).toEqual({
      ok: false,
      error: { code: -32002, message: 'Division by zero' },
    })
    expect(logSlot).toBeUndefined()
    expect(sumOk).toEqual({ ok: true, value: 10 })
  })

  it('handles all-notification batches cleanly', async () => {
    const { transport, sent } = mockTransportFromServer()
    const client = createClient<App>(transport)

    const [a, b] = await client.batch((batch) => [
      batch.notify('ping'),
      batch.notify('log', { message: 'hi' }),
    ])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(sent).toEqual([
      [
        { jsonrpc: '2.0', method: 'ping' },
        { jsonrpc: '2.0', method: 'log', params: { message: 'hi' } },
      ],
    ])
  })

  it('throws KrpcTransportError on non-array, malformed, duplicate, or incomplete batch responses', async () => {
    const nonArray: ClientTransport = async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: 'pong',
    })
    await expect(
      createClient<App>(nonArray).batch((b) => [b.call('ping')])
    ).rejects.toBeInstanceOf(KrpcTransportError)

    const invalidItem: ClientTransport = async () =>
      [{ bad: true }] as unknown as JsonRpcResponsePayload
    await expect(
      createClient<App>(invalidItem).batch((b) => [b.call('ping')])
    ).rejects.toBeInstanceOf(KrpcTransportError)

    const duplicateId: ClientTransport = async () => [
      { jsonrpc: '2.0', id: 1, result: 'pong' },
      { jsonrpc: '2.0', id: 1, result: 'pong' },
    ]
    await expect(
      createClient<App>(duplicateId).batch((b) => [b.call('ping')])
    ).rejects.toThrow('Duplicate JSON-RPC response id')

    const missingId: ClientTransport = async () => [
      { jsonrpc: '2.0', id: 1, result: 'pong' },
      { jsonrpc: '2.0', id: 999, result: 'ignored' },
    ]
    await expect(
      createClient<App>(missingId).batch((b) => [
        b.call('ping'),
        b.call('ping'),
      ])
    ).rejects.toThrow('Incomplete JSON-RPC batch response')

    // Duplicate request IDs produced by a custom nextId fail fast
    const { transport } = mockTransportFromServer()
    const dupIdClient = createClient<App>(transport, { nextId: () => 0 })
    await expect(
      dupIdClient.batch((b) => [b.call('ping'), b.call('ping')])
    ).rejects.toThrow('Duplicate JSON-RPC request id in batch')
  })
})
