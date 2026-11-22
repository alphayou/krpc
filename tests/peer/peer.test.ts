import { describe, expect, it } from 'bun:test'
import { createProxy } from '../../src/client/proxy'
import { createPeer } from '../../src/peer/peer'
import {
  defineError,
  KrpcTimeoutError,
  KrpcTransportError,
} from '../../src/protocol/errors'
import { isPlainObject } from '../../src/protocol/guards'
import type { StandardSchemaV1 } from '../../src/protocol/standard-schema'
import { JSON_RPC_ERROR_CODES } from '../../src/protocol/types'
import { createServer } from '../../src/server/server'
import { defineContext } from '../../src/service/context'
import { onError } from '../../src/service/hooks'
import { defineMethod, defineNotify } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import type { DuplexTransport } from '../../src/transports/types'

function createMockDuplexPair(): [DuplexTransport, DuplexTransport] {
  const msgA = new Set<(m: string) => void>()
  const msgB = new Set<(m: string) => void>()
  const closeA = new Set<(r?: unknown) => void>()
  const closeB = new Set<(r?: unknown) => void>()
  let closed = false

  const closeBoth = (reason?: unknown) => {
    if (closed) return
    closed = true
    for (const h of [...closeA]) h(reason)
    for (const h of [...closeB]) h(reason)
    msgA.clear()
    msgB.clear()
    closeA.clear()
    closeB.clear()
  }

  const makeSide = (
    ownMsg: Set<(m: string) => void>,
    peerMsg: Set<(m: string) => void>,
    ownClose: Set<(r?: unknown) => void>
  ): DuplexTransport => ({
    send(message) {
      if (closed) throw new Error('closed')
      queueMicrotask(() => {
        if (closed) return
        for (const h of [...peerMsg]) h(message)
      })
    },
    onMessage(handler) {
      ownMsg.add(handler)
      return () => ownMsg.delete(handler)
    },
    onClose(handler) {
      ownClose.add(handler)
      return () => ownClose.delete(handler)
    },
    close() {
      closeBoth()
    },
  })

  return [makeSide(msgA, msgB, closeA), makeSide(msgB, msgA, closeB)]
}

const progressSchema: StandardSchemaV1<
  { jobId: string; percent: number },
  { jobId: string; percent: number }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (
        isPlainObject(value) &&
        typeof value.jobId === 'string' &&
        typeof value.percent === 'number'
      ) {
        return { value: { jobId: value.jobId, percent: value.percent } }
      }
      return { issues: [{ message: 'Invalid progress' }] }
    },
  },
}

const NotFound = defineError(-32004, 'Not found').data<{ id: string }>()
const PeerTag = defineContext('default-peer')

describe('createPeer — full-duplex RPC & push notifications', () => {
  it('supports call, batch, proxy, ctx.notify, serverPeer.notify (by path & NotifyDef), and on()', async () => {
    const receivedLogs: string[] = []

    const job = defineService(() => {
      const progress = defineNotify(progressSchema)
      const done = defineNotify<{ jobId: string }>()

      const start = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
        if (jobId === 'missing') return NotFound({ id: jobId })
        await ctx.notify(progress, { jobId, percent: 50 })
        await ctx.notify(done, { jobId })
        return { tag: ctx.get(PeerTag), ok: true }
      })

      return { progress, done, start }
    })

    const serverApp = defineService(() => ({
      ping: defineMethod(() => 'pong' as const),
      log: defineMethod(({ msg }: { msg: string }) => {
        receivedLogs.push(msg)
      }),
      job,
    }))

    const [clientTransport, serverTransport] = createMockDuplexPair()

    const serverPeer = createPeer(serverTransport, serverApp, {
      setupContext(ctx) {
        ctx.set(PeerTag, 'ws-server')
      },
    })
    const clientPeer = createPeer<typeof serverApp>(clientTransport)

    const progressEvents: Array<{ jobId: string; percent: number }> = []
    const doneEvents: Array<{ jobId: string }> = []

    const offProgress = clientPeer.on('job.progress', (payload) => {
      progressEvents.push(payload)
    })
    clientPeer.on('job.done', (payload) => {
      doneEvents.push(payload)
    })

    // Handler uses ctx.notify -> clientPeer.on receives pushes
    const startRes = await clientPeer.call('job.start', { jobId: 'j1' })
    expect(startRes).toEqual({
      ok: true,
      value: { tag: 'ws-server', ok: true },
    })

    // Domain error returned cleanly over duplex peer
    const missingRes = await clientPeer.call('job.start', { jobId: 'missing' })
    expect(missingRes).toEqual({
      ok: false,
      error: { code: -32004, message: 'Not found', data: { id: 'missing' } },
    })

    // Server pushes outside handler by string path AND by NotifyDef token
    await serverPeer.notify('job.progress', { jobId: 'j2', percent: 80 })
    await serverPeer.notify(job.progress, { jobId: 'j2', percent: 100 })
    await new Promise((r) => setTimeout(r, 10))

    expect(progressEvents).toEqual([
      { jobId: 'j1', percent: 50 },
      { jobId: 'j2', percent: 80 },
      { jobId: 'j2', percent: 100 },
    ])
    expect(doneEvents).toEqual([{ jobId: 'j1' }])

    // Unsubscribe stops future deliveries
    offProgress()
    await serverPeer.notify('job.progress', { jobId: 'j3', percent: 10 })
    await new Promise((r) => setTimeout(r, 10))
    expect(progressEvents).toHaveLength(3)

    // Client notifies remote method (no id, no reply)
    await clientPeer.notify('log', { msg: 'from-client' })
    await new Promise((r) => setTimeout(r, 10))
    expect(receivedLogs).toEqual(['from-client'])

    // Client batch over duplex peer (mixed + empty + all-notify)
    expect(await clientPeer.batch(() => [])).toEqual([])
    const [pongRes, logRes] = await clientPeer.batch((b) => [
      b.call('ping'),
      b.notify('log', { msg: 'in-batch' }),
    ])
    expect(pongRes).toEqual({ ok: true, value: 'pong' })
    expect(logRes).toBeUndefined()
    expect(receivedLogs).toEqual(['from-client', 'in-batch'])

    const allNotify = await clientPeer.batch((b) => [
      b.notify('log', { msg: 'batch-only' }),
    ])
    expect(allNotify).toEqual([undefined])
    await new Promise((r) => setTimeout(r, 10))
    expect(receivedLogs).toEqual(['from-client', 'in-batch', 'batch-only'])

    // createProxy works directly on a peer
    const rpc = createProxy(clientPeer)
    expect(await rpc.ping()).toEqual({ ok: true, value: 'pong' })

    // Invalid schema on serverPeer.notify throws fast
    await expect(
      serverPeer.notify('job.progress', {
        jobId: 'j4',
        percent: 'bad' as never,
      })
    ).rejects.toThrow('Invalid outbound notification params')
    await expect(
      serverPeer.notify(job.progress, {
        jobId: 'j4',
        percent: 'bad' as never,
      })
    ).rejects.toThrow('Invalid outbound notification params')

    const unregistered = defineNotify<{ x: number }>()
    await expect(serverPeer.notify(unregistered, { x: 1 })).rejects.toThrow(
      'Notification definition is not registered'
    )

    await clientPeer.close()
  })

  it('supports bidirectional calls and accepting a pre-built RpcServer', async () => {
    const sideAApp = defineService(() => ({
      helloA: defineMethod(({ name }: { name: string }) => `A:${name}`),
    }))
    const sideBApp = defineService(() => ({
      helloB: defineMethod(({ name }: { name: string }) => `B:${name}`),
    }))

    const [tA, tB] = createMockDuplexPair()
    const serverA = createServer(sideAApp)

    const peerA = createPeer<typeof sideBApp, typeof sideAApp>(tA, serverA)
    const peerB = createPeer<typeof sideAApp, typeof sideBApp>(tB, sideBApp)

    expect(await peerA.call('helloB', { name: 'fromA' })).toEqual({
      ok: true,
      value: 'B:fromA',
    })
    expect(await peerB.call('helloA', { name: 'fromB' })).toEqual({
      ok: true,
      value: 'A:fromB',
    })

    await peerA.close()
  })

  it('rejects all in-flight calls and batches immediately on transport close and enforces timeouts', async () => {
    const slowApp = defineService(() => ({
      hang: defineMethod(async () => {
        await new Promise((r) => setTimeout(r, 500))
        return 'late'
      }),
    }))

    const [clientTransport, serverTransport] = createMockDuplexPair()
    createPeer(serverTransport, slowApp)
    const clientPeer = createPeer<typeof slowApp>(clientTransport)

    // Timeout rejects and cleans up pending entry
    await expect(
      clientPeer.call('hang', undefined, { timeout: 15 })
    ).rejects.toBeInstanceOf(KrpcTimeoutError)

    // Closing transport rejects all pending calls and batches
    const pCallErr = clientPeer.call('hang').catch((e: unknown) => e)
    const pBatchErr = clientPeer
      .batch((b) => [b.call('hang')])
      .catch((e: unknown) => e)

    await serverTransport.close()

    expect(await pCallErr).toBeInstanceOf(KrpcTransportError)
    expect(await pBatchErr).toBeInstanceOf(KrpcTransportError)

    // Subsequent calls after close immediately reject
    await expect(clientPeer.call('hang')).rejects.toThrow('Transport closed')
    await expect(clientPeer.batch((b) => [b.call('hang')])).rejects.toThrow(
      'Transport closed'
    )
  })

  it('handles malformed inbound frames, unexpected requests on client-only peers, and incomplete batch responses', async () => {
    const [tA, tB] = createMockDuplexPair()
    const replies: unknown[] = []
    tB.onMessage((raw) => {
      replies.push(JSON.parse(raw))
    })

    const app = defineService(() => ({
      ping: defineMethod(() => 'pong'),
      tick: defineNotify<{ n: number }>(),
    }))
    const clientPeer = createPeer<typeof app>(tA)

    const ticks: number[] = []
    clientPeer.on('tick', ({ n }) => {
      ticks.push(n)
      throw new Error('subscriber error must be isolated')
    })

    // Send malformed JSON -> -32700 Parse error
    tB.send('{bad json')
    // Send unexpected request to client-only peer -> -32601
    tB.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'unknown' }))
    // Send invalid object -> -32600
    tB.send(JSON.stringify({ jsonrpc: '1.0', id: 11, method: 'x' }))
    // Send batch of notification + request + invalid item
    tB.send(
      JSON.stringify([
        { jsonrpc: '2.0', method: 'tick', params: { n: 7 } },
        { jsonrpc: '2.0', id: 12, method: 'unknown' },
        42,
      ])
    )

    await new Promise((r) => setTimeout(r, 15))
    expect(ticks).toEqual([7])
    expect(replies).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
          message: 'Parse error',
        },
      },
      {
        jsonrpc: '2.0',
        id: 10,
        error: {
          code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: 'Method not found',
        },
      },
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid Request',
        },
      },
      [
        {
          jsonrpc: '2.0',
          id: 12,
          error: {
            code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            message: 'Method not found',
          },
        },
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            message: 'Invalid Request',
          },
        },
      ],
    ])

    // Incomplete batch response from remote rejects pending batch
    const batchPromise = clientPeer.batch((b) => [
      b.call('ping'),
      b.call('ping'),
    ])
    await new Promise((r) => setTimeout(r, 5))
    tB.send(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: 'pong' }]))
    await expect(batchPromise).rejects.toThrow(
      'Incomplete JSON-RPC batch response'
    )

    await clientPeer.close()
  })

  it('handles falsy IDs (0 and ""), batch errors, duplicate IDs, void notifies, async subscriber errors, and send failures', async () => {
    const app = defineService(() => {
      const heartbeat = defineNotify()
      const ping = defineMethod(() => 'pong' as const)
      const echo = defineMethod(({ v }: { v: string }) => v)
      const fail = defineMethod(() => NotFound({ id: '42' }))
      const pulse = defineMethod(async (_, ctx) => {
        await ctx.notify(heartbeat)
        return 'pulsed'
      })
      return { heartbeat, ping, echo, fail, pulse }
    })

    const [tA, tB] = createMockDuplexPair()
    const serverPeer = createPeer(tB, app)
    const ids: Array<number | string> = [0, '', 0, '']
    let idx = 0
    const clientPeer = createPeer<typeof app>(tA, undefined, {
      nextId: () => ids[idx++]!,
    })

    // Async subscriber returning a rejected promise must be isolated cleanly
    let heartbeats = 0
    clientPeer.on('heartbeat', async () => {
      heartbeats++
      throw new Error('async subscriber failure')
    })

    // Single calls with falsy IDs (0 and "")
    expect(await clientPeer.call('pulse')).toEqual({
      ok: true,
      value: 'pulsed',
    })
    expect(await clientPeer.call('echo', { v: 'empty-id' })).toEqual({
      ok: true,
      value: 'empty-id',
    })

    // Batch with falsy IDs (0 and ""), params, domain error, and void notify
    const [echoRes, failRes, notifySlot] = await clientPeer.batch((b) => [
      b.call('echo', { v: 'batched' }),
      b.call('fail'),
      b.notify('ping'),
    ])
    expect(echoRes).toEqual({ ok: true, value: 'batched' })
    expect(failRes).toEqual({
      ok: false,
      error: { code: -32004, message: 'Not found', data: { id: '42' } },
    })
    expect(notifySlot).toBeUndefined()

    // Void peer.notify on both server and client
    await serverPeer.notify('heartbeat')
    await clientPeer.notify('ping')
    await new Promise((r) => setTimeout(r, 10))
    expect(heartbeats).toBe(2)

    // Pre-aborted signal on all-notification batch rejects without sending
    const ac = new AbortController()
    ac.abort(new Error('aborted-notify-batch'))
    await expect(
      clientPeer.batch((b) => [b.notify('ping')], { signal: ac.signal })
    ).rejects.toThrow('aborted-notify-batch')

    // Duplicate generated request ID in peer.batch rejects cleanly
    const dupPeer = createPeer<typeof app>(tA, undefined, { nextId: () => 0 })
    await expect(
      dupPeer.batch((b) => [b.call('ping'), b.call('ping')])
    ).rejects.toThrow('Duplicate JSON-RPC request id in batch')

    await clientPeer.close()
    // peer.notify after close throws Transport closed
    await expect(clientPeer.notify('ping')).rejects.toThrow('Transport closed')

    // Duplicate response ID in inbound batch response rejects cleanly
    const [tC, tD] = createMockDuplexPair()
    const peerC = createPeer<typeof app>(tC, undefined, { nextId: () => 0 })
    const dupRespBatch = peerC.batch((b) => [b.call('ping')])
    await new Promise((r) => setTimeout(r, 5))
    tD.send(
      JSON.stringify([
        { jsonrpc: '2.0', id: 0, result: 'a' },
        { jsonrpc: '2.0', id: 0, result: 'b' },
      ])
    )
    await expect(dupRespBatch).rejects.toThrow(
      'Duplicate JSON-RPC response id in batch'
    )
    await peerC.close()

    // Failing transport.send wraps plain Error and preserves KrpcTransportError
    let inboundHandler: ((m: string) => void) | undefined
    let failMode: 'plain' | 'transport' = 'plain'
    const flakyTransport: DuplexTransport = {
      send() {
        if (failMode === 'transport') {
          throw new KrpcTransportError('already-transport')
        }
        throw new Error('raw-write-fail')
      },
      onMessage(h) {
        inboundHandler = h
        return () => {}
      },
      onClose() {
        return () => {}
      },
      close() {},
    }
    const flakyPeer = createPeer<typeof app>(flakyTransport)

    await expect(flakyPeer.call('ping')).rejects.toThrow(
      'Failed to send JSON-RPC frame'
    )
    failMode = 'transport'
    await expect(flakyPeer.batch((b) => [b.call('ping')])).rejects.toThrow(
      'already-transport'
    )
    // sendFrameBestEffort catches synchronous transport.send errors cleanly
    inboundHandler?.('{bad json')
    await flakyPeer.close()
  })

  it('exposes ctx.clientId, silently drops ctx.notify on closed transport, and orders ctx.after strictly after call response', async () => {
    const errors: string[] = []
    let notifyAfterCloseResult: boolean | undefined
    let releaseHandler: (() => void) | undefined

    const app = defineService(() => {
      onError((err) => {
        errors.push(err instanceof Error ? err.message : String(err))
      })

      const done = defineNotify<{ jobId: string }>()

      const whoami = defineMethod((_, ctx) => ({
        clientId: ctx.clientId ?? null,
        canNotify: ctx.canNotify,
      }))

      const startEarly = defineMethod(({ jobId }: { jobId: string }, ctx) => {
        ctx.after(async () => {
          await ctx.notify(done, { jobId })
        })
        return { accepted: jobId }
      })

      const slowAfter = defineMethod(({ jobId }: { jobId: string }, ctx) => {
        ctx.after(async () => {
          await new Promise((r) => setTimeout(r, 30))
          await ctx.notify(done, { jobId })
        })
        return { accepted: jobId }
      })

      const failAfter = defineMethod((_, ctx) => {
        ctx.after(async () => {
          throw new Error('peer-after-boom')
        })
        return 'replied'
      })

      const notifyAfterClose = defineMethod(async (_, ctx) => {
        await new Promise<void>((resolve) => {
          releaseHandler = resolve
        })
        notifyAfterCloseResult = await ctx.notify(done, { jobId: 'late' })
        return 'finished'
      })

      return {
        done,
        whoami,
        startEarly,
        slowAfter,
        failAfter,
        notifyAfterClose,
      }
    })

    const [clientTransport, serverTransport] = createMockDuplexPair()
    const serverPeer = createPeer(serverTransport, app, { id: 'peer-42' })
    const clientPeer = createPeer<typeof app>(clientTransport)

    // 1. ctx.clientId populated from createPeer(..., { id })
    expect(await clientPeer.call('whoami')).toEqual({
      ok: true,
      value: { clientId: 'peer-42', canNotify: true },
    })

    // 2. ctx.after() delivers call response strictly BEFORE ctx.notify()
    const order: string[] = []
    clientPeer.on('done', ({ jobId }) => {
      order.push(`notify:${jobId}`)
    })

    const res = await clientPeer.call('startEarly', { jobId: 'p1' })
    order.push(`response:${res.ok ? res.value.accepted : 'err'}`)
    await new Promise((r) => setTimeout(r, 15))
    expect(order).toEqual(['response:p1', 'notify:p1'])

    // 3. Batch also delivers batch response strictly BEFORE ctx.notify()
    order.length = 0
    const [b0, b1] = await clientPeer.batch((b) => [
      b.call('startEarly', { jobId: 'pb1' }),
      b.call('startEarly', { jobId: 'pb2' }),
    ])
    order.push(
      `batch:${b0.ok ? b0.value.accepted : 'err'},${b1.ok ? b1.value.accepted : 'err'}`
    )
    await new Promise((r) => setTimeout(r, 15))
    expect(order[0]).toBe('batch:pb1,pb2')
    expect(order).toContain('notify:pb1')
    expect(order).toContain('notify:pb2')

    // 4. Early reply returns immediately before slow ctx.after finishes
    order.length = 0
    const t0 = performance.now()
    const slowRes = await clientPeer.call('slowAfter', { jobId: 'slow-1' })
    const elapsed = performance.now() - t0
    expect(slowRes).toEqual({ ok: true, value: { accepted: 'slow-1' } })
    expect(elapsed).toBeLessThan(25)
    expect(order).toEqual([])
    await new Promise((r) => setTimeout(r, 45))
    expect(order).toEqual(['notify:slow-1'])

    // 5. Notification calling ctx.after still runs
    order.length = 0
    await clientPeer.notify('startEarly', { jobId: 'from-notif' })
    await new Promise((r) => setTimeout(r, 15))
    expect(order).toEqual(['notify:from-notif'])

    // 6. Error in ctx.after is caught by onError
    expect(await clientPeer.call('failAfter')).toEqual({
      ok: true,
      value: 'replied',
    })
    await new Promise((r) => setTimeout(r, 15))
    expect(errors).toEqual(['peer-after-boom'])

    // 7. ctx.notify on a closed connection silently drops and returns false (never throws)
    const inflight = clientPeer
      .call('notifyAfterClose')
      .catch(() => 'closed-client')
    await new Promise((r) => setTimeout(r, 10))
    await serverPeer.close()
    releaseHandler?.()
    await inflight
    await new Promise((r) => setTimeout(r, 15))
    expect(notifyAfterCloseResult).toBe(false)
  })
})
