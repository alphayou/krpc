import { describe, expect, test } from 'bun:test'
import { createClient } from '../../src/client/client'
import { defineError, KrpcTransportError } from '../../src/protocol/errors'
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcRequestPayload,
  JsonRpcResponse,
  JsonRpcResponsePayload,
} from '../../src/protocol/types'
import { createServer } from '../../src/server/server'
import { defineMethod } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import { batchTransport } from '../../src/transports/batch'
import { createMemoryTransport } from '../../src/transports/memory'
import type {
  ClientTransport,
  TransportSendOptions,
} from '../../src/transports/types'

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('batchTransport', () => {
  test('validates options', () => {
    const noop: ClientTransport = async () => undefined
    expect(() => batchTransport(noop, { windowMs: -1 })).toThrow(RangeError)
    expect(() => batchTransport(noop, { windowMs: Number.NaN })).toThrow(
      RangeError
    )
    expect(() =>
      batchTransport(noop, { windowMs: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError)
    expect(() => batchTransport(noop, { maxBatchSize: 0 })).toThrow(RangeError)
    expect(() => batchTransport(noop, { maxBatchSize: -5 })).toThrow(RangeError)
    expect(() => batchTransport(noop, { maxBatchSize: 1.5 })).toThrow(
      RangeError
    )
    expect(() => batchTransport(noop, { maxBatchSize: Number.NaN })).toThrow(
      RangeError
    )
  })

  test('coalesces concurrent calls within the same microtask into a single batch', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const transport: ClientTransport = async (payload) => {
      sent.push(payload)
      const list = payload as readonly JsonRpcRequest[]
      return list
        .slice()
        .reverse()
        .map((req) => ({
          jsonrpc: '2.0' as const,
          id: req.id,
          result: `${req.method}:${String(req.id)}`,
        }))
    }

    const batched = batchTransport(transport)
    const r1: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'a' }
    const r2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: 'b' }
    const r3: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: 'c' }

    const [res1, res2, res3] = await Promise.all([
      batched(r1),
      batched(r2),
      batched(r3),
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual([r1, r2, r3])
    expect(res1).toEqual({ jsonrpc: '2.0', id: 1, result: 'a:1' })
    expect(res2).toEqual({ jsonrpc: '2.0', id: 2, result: 'b:2' })
    expect(res3).toEqual({ jsonrpc: '2.0', id: 3, result: 'c:3' })
  })

  test('uses single-item fast path when only one item is queued at flush time', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const signals: (AbortSignal | undefined)[] = []

    const transport: ClientTransport = async (payload, options) => {
      sent.push(payload)
      signals.push(options?.signal)
      const req = payload as JsonRpcRequest
      return { jsonrpc: '2.0', id: req.id, result: 'solo' }
    }

    const batched = batchTransport(transport)
    const controller = new AbortController()
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'ping' }

    const res = await batched(req, { signal: controller.signal })

    expect(sent).toHaveLength(1)
    expect(Array.isArray(sent[0])).toBe(false)
    expect(sent[0]).toEqual(req)
    expect(signals[0]).toBe(controller.signal)
    expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: 'solo' })
  })

  test('coalesces calls across microtasks when windowMs > 0', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const transport: ClientTransport = async (payload) => {
      sent.push(payload)
      if (!Array.isArray(payload)) {
        const req = payload as JsonRpcRequest
        return { jsonrpc: '2.0', id: req.id, result: req.method }
      }
      return payload.map((req) => ({
        jsonrpc: '2.0' as const,
        id: (req as JsonRpcRequest).id,
        result: req.method,
      }))
    }

    const batched = batchTransport(transport, { windowMs: 25 })

    const p1 = batched({ jsonrpc: '2.0', id: 1, method: 'first' })
    await Promise.resolve()
    await Bun.sleep(5)
    const p2 = batched({ jsonrpc: '2.0', id: 2, method: 'second' })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(sent).toHaveLength(1)
    expect(Array.isArray(sent[0])).toBe(true)
    expect(r1).toEqual({ jsonrpc: '2.0', id: 1, result: 'first' })
    expect(r2).toEqual({ jsonrpc: '2.0', id: 2, result: 'second' })

    // Next call after window closes goes in a separate flush (single-item fast path).
    const r3 = await batched({ jsonrpc: '2.0', id: 3, method: 'third' })
    expect(sent).toHaveLength(2)
    expect(Array.isArray(sent[1])).toBe(false)
    expect(r3).toEqual({ jsonrpc: '2.0', id: 3, result: 'third' })
  })

  test('flushes eagerly when queue reaches maxBatchSize', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const transport: ClientTransport = async (payload) => {
      sent.push(payload)
      if (!Array.isArray(payload)) {
        const req = payload as JsonRpcRequest
        return { jsonrpc: '2.0', id: req.id, result: req.id }
      }
      return payload.map((req) => ({
        jsonrpc: '2.0' as const,
        id: (req as JsonRpcRequest).id,
        result: (req as JsonRpcRequest).id,
      }))
    }

    const batched = batchTransport(transport, {
      windowMs: 1000,
      maxBatchSize: 2,
    })

    const p1 = batched({ jsonrpc: '2.0', id: 1, method: 'm' })
    expect(sent).toHaveLength(0)

    // Second item hits maxBatchSize and flushes synchronously without waiting for windowMs.
    const p2 = batched({ jsonrpc: '2.0', id: 2, method: 'm' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(2)

    const p3 = batched({ jsonrpc: '2.0', id: 3, method: 'm' })
    const p4 = batched({ jsonrpc: '2.0', id: 4, method: 'm' })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toHaveLength(2)

    const results = await Promise.all([p1, p2, p3, p4])
    expect(results).toEqual([
      { jsonrpc: '2.0', id: 1, result: 1 },
      { jsonrpc: '2.0', id: 2, result: 2 },
      { jsonrpc: '2.0', id: 3, result: 3 },
      { jsonrpc: '2.0', id: 4, result: 4 },
    ])

    // Also test microtask mode with eager flush + trailing single item.
    const sentMicro: JsonRpcRequestPayload[] = []
    const batchedMicro = batchTransport(
      async (payload) => {
        sentMicro.push(payload)
        if (!Array.isArray(payload)) {
          const req = payload as JsonRpcRequest
          return { jsonrpc: '2.0', id: req.id, result: req.id }
        }
        return payload.map((req) => ({
          jsonrpc: '2.0' as const,
          id: (req as JsonRpcRequest).id,
          result: (req as JsonRpcRequest).id,
        }))
      },
      { maxBatchSize: 2 }
    )

    const [a, b, c] = await Promise.all([
      batchedMicro({ jsonrpc: '2.0', id: 10, method: 'm' }),
      batchedMicro({ jsonrpc: '2.0', id: 11, method: 'm' }),
      batchedMicro({ jsonrpc: '2.0', id: 12, method: 'm' }),
    ])

    expect(sentMicro).toHaveLength(2)
    expect(Array.isArray(sentMicro[0])).toBe(true)
    expect(sentMicro[0]).toHaveLength(2)
    expect(Array.isArray(sentMicro[1])).toBe(false)
    expect([a, b, c]).toEqual([
      { jsonrpc: '2.0', id: 10, result: 10 },
      { jsonrpc: '2.0', id: 11, result: 11 },
      { jsonrpc: '2.0', id: 12, result: 12 },
    ])
  })

  test('handles mixed requests and notifications cleanly', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const transport: ClientTransport = async (payload) => {
      sent.push(payload)
      const list = payload as readonly (JsonRpcRequest | JsonRpcNotification)[]
      const responses: JsonRpcResponse[] = []
      for (const item of list) {
        if ('id' in item && item.id !== undefined) {
          responses.push({
            jsonrpc: '2.0',
            id: item.id,
            result: `ok:${item.method}`,
          })
        }
      }
      return responses
    }

    const batched = batchTransport(transport)
    const [r1, n1, r2, n2] = await Promise.all([
      batched({ jsonrpc: '2.0', id: 1, method: 'get' }),
      batched({ jsonrpc: '2.0', method: 'audit', params: { event: 'a' } }),
      batched({ jsonrpc: '2.0', id: 2, method: 'set' }),
      batched({ jsonrpc: '2.0', method: 'audit', params: { event: 'b' } }),
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(4)
    expect(r1).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok:get' })
    expect(n1).toBeUndefined()
    expect(r2).toEqual({ jsonrpc: '2.0', id: 2, result: 'ok:set' })
    expect(n2).toBeUndefined()
  })

  test('handles all-notification batches resolving every caller to undefined', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const transport: ClientTransport = async (payload) => {
      sent.push(payload)
      return undefined
    }

    const batched = batchTransport(transport)
    const results = await Promise.all([
      batched({ jsonrpc: '2.0', method: 'log', params: { n: 1 } }),
      batched({ jsonrpc: '2.0', method: 'log', params: { n: 2 } }),
      batched({ jsonrpc: '2.0', method: 'log', params: { n: 3 } }),
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(3)
    expect(results).toEqual([undefined, undefined, undefined])
  })

  test('passes already-batched arrays directly through immediately without nesting', async () => {
    const calls: Array<{
      payload: JsonRpcRequestPayload
      options?: TransportSendOptions
    }> = []

    const transport: ClientTransport = async (payload, options) => {
      calls.push({ payload, options })
      return [
        { jsonrpc: '2.0', id: 1, result: 'one' },
        { jsonrpc: '2.0', id: 2, result: 'two' },
      ]
    }

    const batched = batchTransport(transport, { windowMs: 1000 })
    const controller = new AbortController()
    const preBatched: readonly JsonRpcRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'a' },
      { jsonrpc: '2.0', id: 2, method: 'b' },
    ]

    const res = await batched(preBatched, { signal: controller.signal })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toBe(preBatched)
    expect(calls[0]?.options?.signal).toBe(controller.signal)
    expect(res).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'one' },
      { jsonrpc: '2.0', id: 2, result: 'two' },
    ])
  })

  test('routes falsy request IDs (0, "", null) accurately without collisions', async () => {
    const transport: ClientTransport = async (payload) => {
      const list = payload as readonly JsonRpcRequest[]
      return list.map((req) => ({
        jsonrpc: '2.0' as const,
        id: req.id,
        result: { kind: typeof req.id, value: req.id },
      }))
    }

    const batched = batchTransport(transport)
    const [rZero, rEmpty, rNull, rZeroStr] = await Promise.all([
      batched({ jsonrpc: '2.0', id: 0, method: 'm' }),
      batched({ jsonrpc: '2.0', id: '', method: 'm' }),
      batched({ jsonrpc: '2.0', id: null, method: 'm' }),
      batched({ jsonrpc: '2.0', id: '0', method: 'm' }),
    ])

    expect(rZero).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { kind: 'number', value: 0 },
    })
    expect(rEmpty).toEqual({
      jsonrpc: '2.0',
      id: '',
      result: { kind: 'string', value: '' },
    })
    expect(rNull).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: { kind: 'object', value: null },
    })
    expect(rZeroStr).toEqual({
      jsonrpc: '2.0',
      id: '0',
      result: { kind: 'string', value: '0' },
    })
  })

  test('handles AbortSignal before enqueue and before flush', async () => {
    const sent: JsonRpcRequestPayload[] = []
    const transport: ClientTransport = async (payload) => {
      sent.push(payload)
      const req = payload as JsonRpcRequest
      return { jsonrpc: '2.0', id: req.id, result: req.method }
    }

    const batched = batchTransport(transport, { windowMs: 30 })

    // Already aborted signal rejects immediately without touching transport.
    const preAborted = new AbortController()
    const preReason = new Error('pre-aborted')
    preAborted.abort(preReason)
    await expect(
      batched(
        { jsonrpc: '2.0', id: 1, method: 'never' },
        { signal: preAborted.signal }
      )
    ).rejects.toBe(preReason)
    expect(sent).toHaveLength(0)

    // Sole queued item aborts before timer fires -> queue empties and transport is never called.
    const soleCtrl = new AbortController()
    const soleReason = new Error('cancelled-sole')
    const solePromise = batched(
      { jsonrpc: '2.0', id: 2, method: 'cancelled' },
      { signal: soleCtrl.signal }
    )
    soleCtrl.abort(soleReason)
    await expect(solePromise).rejects.toBe(soleReason)
    await Bun.sleep(45)
    expect(sent).toHaveLength(0)

    // One of two queued items aborts before flush -> remaining item takes single-item fast path.
    const c1 = new AbortController()
    const p1 = batched(
      { jsonrpc: '2.0', id: 3, method: 'drop-me' },
      { signal: c1.signal }
    )
    const p2 = batched({ jsonrpc: '2.0', id: 4, method: 'keep-me' })
    c1.abort('dropped')

    await expect(p1).rejects.toBe('dropped')
    expect(await p2).toEqual({ jsonrpc: '2.0', id: 4, result: 'keep-me' })
    expect(sent).toHaveLength(1)
    expect(Array.isArray(sent[0])).toBe(false)
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 4, method: 'keep-me' })
  })

  test('handles per-call AbortSignal after flush without breaking sibling calls', async () => {
    const deferred = createDeferred<JsonRpcResponsePayload>()
    let receivedSignal: AbortSignal | undefined

    const transport: ClientTransport = (_payload, options) => {
      receivedSignal = options?.signal
      return deferred.promise
    }

    const batched = batchTransport(transport)
    const c1 = new AbortController()
    const c2 = new AbortController()

    const p1 = batched(
      { jsonrpc: '2.0', id: 1, method: 'slow-1' },
      { signal: c1.signal }
    )
    const p2 = batched(
      { jsonrpc: '2.0', id: 2, method: 'slow-2' },
      { signal: c2.signal }
    )

    // Let microtask flush the batch to the underlying transport.
    await Promise.resolve()
    expect(receivedSignal).toBeUndefined()

    // Abort caller 1 while the batch is in-flight.
    const abortReason = new Error('caller-1-aborted')
    c1.abort(abortReason)
    await expect(p1).rejects.toBe(abortReason)

    // Batch completes -> caller 2 resolves normally!
    deferred.resolve([
      { jsonrpc: '2.0', id: 1, result: 'late-1' },
      { jsonrpc: '2.0', id: 2, result: 'ok-2' },
    ])
    expect(await p2).toEqual({ jsonrpc: '2.0', id: 2, result: 'ok-2' })
  })

  test('handles single-item fast path abort after flush cleanly', async () => {
    let forwardedSignal: AbortSignal | undefined
    const deferred = createDeferred<JsonRpcResponsePayload>()

    const transport: ClientTransport = (_payload, options) => {
      forwardedSignal = options?.signal
      return deferred.promise
    }

    const batched = batchTransport(transport)
    const ctrl = new AbortController()
    const p = batched(
      { jsonrpc: '2.0', id: 1, method: 'hang' },
      { signal: ctrl.signal }
    )

    await Promise.resolve()
    expect(forwardedSignal).toBe(ctrl.signal)

    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })

    // Late rejection from underlying transport must not trigger unhandled rejection.
    deferred.reject(new Error('late-failure'))
    await Promise.resolve()
  })

  test('rejects callers when transport throws (async or sync)', async () => {
    const boom = new KrpcTransportError('network down')
    const asyncFailing = batchTransport(async () => {
      throw boom
    })

    const [a, b] = await Promise.allSettled([
      asyncFailing({ jsonrpc: '2.0', id: 1, method: 'x' }),
      asyncFailing({ jsonrpc: '2.0', id: 2, method: 'y' }),
    ])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('rejected')
    if (a.status === 'rejected') expect(a.reason).toBe(boom)
    if (b.status === 'rejected') expect(b.reason).toBe(boom)

    // Single-item sync throw
    const syncBoom = new Error('sync boom')
    const syncFailing = batchTransport(() => {
      throw syncBoom
    })
    await expect(
      syncFailing({ jsonrpc: '2.0', id: 1, method: 'x' })
    ).rejects.toBe(syncBoom)
  })

  test('rejects callers cleanly on missing response id, duplicate id, or non-array response', async () => {
    // Missing response for id 2, valid response for id 1
    const partial = batchTransport(async () => [
      { jsonrpc: '2.0', id: 1, result: 'found' },
    ])

    const p1 = partial({ jsonrpc: '2.0', id: 1, method: 'a' })
    const p2 = partial({ jsonrpc: '2.0', id: 2, method: 'b' })
    expect(await p1).toEqual({ jsonrpc: '2.0', id: 1, result: 'found' })
    await expect(p2).rejects.toBeInstanceOf(KrpcTransportError)

    // Duplicate response for id 1
    const duplicate = batchTransport(async () => [
      { jsonrpc: '2.0', id: 1, result: 'first' },
      { jsonrpc: '2.0', id: 1, result: 'second' },
      { jsonrpc: '2.0', id: 2, result: 'ok' },
    ])
    const d1 = duplicate({ jsonrpc: '2.0', id: 1, method: 'a' })
    const d2 = duplicate({ jsonrpc: '2.0', id: 2, method: 'b' })
    await expect(d1).rejects.toBeInstanceOf(KrpcTransportError)
    expect(await d2).toEqual({ jsonrpc: '2.0', id: 2, result: 'ok' })

    // Single JSON-RPC error object (e.g. -32600) rejects ALL queued callers in the batch
    const batchError = batchTransport(async () => ({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Batch size exceeds maximum of 1' },
    }))
    const [errReqRes, errNotifRes] = await Promise.allSettled([
      batchError({ jsonrpc: '2.0', id: 1, method: 'a' }),
      batchError({ jsonrpc: '2.0', method: 'notify' }),
    ])
    expect(errReqRes.status).toBe('rejected')
    expect(errNotifRes.status).toBe('rejected')
    if (errReqRes.status === 'rejected') {
      expect(errReqRes.reason).toBeInstanceOf(KrpcTransportError)
      expect((errReqRes.reason as Error).message).toBe(
        'JSON-RPC batch error (-32600): Batch size exceeds maximum of 1'
      )
    }
    if (errNotifRes.status === 'rejected') {
      expect(errNotifRes.reason).toBeInstanceOf(KrpcTransportError)
    }

    // All-notification batch rejected with single JSON-RPC error object also rejects all callers
    const notifOnlyErr = batchTransport(async () => ({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Batch rejected' },
    }))
    const [nErr1, nErr2] = await Promise.allSettled([
      notifOnlyErr({ jsonrpc: '2.0', method: 'log' }),
      notifOnlyErr({ jsonrpc: '2.0', method: 'log' }),
    ])
    expect(nErr1.status).toBe('rejected')
    expect(nErr2.status).toBe('rejected')
    if (nErr1.status === 'rejected') {
      expect(nErr1.reason).toBeInstanceOf(KrpcTransportError)
    }

    // Non-array non-error response for mixed batch rejects requests and resolves notifications
    const nonArray = batchTransport(async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: 'unexpected-single',
    }))
    const naReq = nonArray({ jsonrpc: '2.0', id: 1, method: 'a' })
    const naNotif = nonArray({ jsonrpc: '2.0', method: 'notify' })
    await expect(naReq).rejects.toBeInstanceOf(KrpcTransportError)
    expect(await naNotif).toBeUndefined()
  })

  test('cleanly rejects all queued callers when batch exceeds server maxBatchSize', async () => {
    const app = defineService(() => ({
      echo: defineMethod(({ n }: { n: number }) => n),
    }))
    const server = createServer(app, { maxBatchSize: 2 })
    const client = createClient<typeof app>(
      batchTransport(createMemoryTransport(server))
    )

    const results = await Promise.allSettled([
      client.call('echo', { n: 1 }),
      client.call('echo', { n: 2 }),
      client.call('echo', { n: 3 }),
    ])
    for (const outcome of results) {
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(KrpcTransportError)
        expect((outcome.reason as Error).message).toContain('-32600')
      }
    }
  })

  test('integrates seamlessly with createClient and createMemoryTransport', async () => {
    const NotFound = defineError(-32001, 'Not found')
    const logged: string[] = []

    const app = defineService(() => ({
      double: defineMethod(({ n }: { n: number }) => n * 2),
      find: defineMethod(({ id }: { id: string }) =>
        id === 'ok' ? { id } : NotFound()
      ),
      log: defineMethod(({ msg }: { msg: string }) => {
        logged.push(msg)
      }),
    }))

    const server = createServer(app)
    const memory = createMemoryTransport(server)
    const wirePayloads: JsonRpcRequestPayload[] = []
    const spyTransport: ClientTransport = (payload, opts) => {
      wirePayloads.push(payload)
      return memory(payload, opts)
    }

    const client = createClient<typeof app>(batchTransport(spyTransport))

    const [r1, r2, r3] = await Promise.all([
      client.call('double', { n: 21 }),
      client.call('find', { id: 'missing' }),
      client.notify('log', { msg: 'batched' }),
    ])

    expect(wirePayloads).toHaveLength(1)
    expect(Array.isArray(wirePayloads[0])).toBe(true)
    expect(r1).toEqual({ ok: true, value: 42 })
    expect(r2).toEqual({
      ok: false,
      error: { code: -32001, message: 'Not found' },
    })
    expect(r3).toBeUndefined()
    expect(logged).toEqual(['batched'])

    // Explicit client.batch passes directly through without nesting.
    const batchRes = await client.batch((b) => [
      b.call('double', { n: 3 }),
      b.call('find', { id: 'ok' }),
    ])
    expect(wirePayloads).toHaveLength(2)
    expect(wirePayloads[1]).toHaveLength(2)
    expect(batchRes).toEqual([
      { ok: true, value: 6 },
      { ok: true, value: { id: 'ok' } },
    ])
  })
})
