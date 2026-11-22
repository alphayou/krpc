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
})
