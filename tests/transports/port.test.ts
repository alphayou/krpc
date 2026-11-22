import { describe, expect, test } from 'bun:test'
import { createPeer } from '../../src/peer/peer'
import { portTransport as portTransportEntry } from '../../src/port'
import { defineError, KrpcTransportError } from '../../src/protocol/errors'
import { defineMethod, defineNotify } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import { portTransport, type MessagePortLike } from '../../src/transports/port'
import { isDuplexTransport } from '../../src/transports/types'

class MockPort implements MessagePortLike {
  posted: unknown[] = []
  startedCount = 0
  closedCount = 0
  throwOnPost = false
  private listeners = new Map<string, Set<(event: any) => void>>()

  postMessage(message: unknown): void {
    if (this.throwOnPost) {
      throw new Error('postMessage failed')
    }
    this.posted.push(message)
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  start(): void {
    this.startedCount++
  }

  close(): void {
    this.closedCount++
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  emit(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
  }
}

describe('krpc/port subpath export', () => {
  test('re-exports portTransport from src/port.ts', () => {
    expect(portTransportEntry).toBe(portTransport)
  })
})

describe('portTransport (unit)', () => {
  test('calls port.start(), validates DuplexTransport shape, and cleans up on close()', async () => {
    const port = new MockPort()
    const transport = portTransport(port)

    expect(isDuplexTransport(transport)).toBe(true)
    expect(port.startedCount).toBe(1)
    expect(port.listenerCount('message')).toBe(1)
    expect(port.listenerCount('close')).toBe(1)

    await transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}')
    expect(port.posted).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}'])

    let closeCalls = 0
    transport.onClose(() => {
      closeCalls++
    })

    transport.close()
    transport.close()
    port.emit('close', 'duplicate')

    expect(closeCalls).toBe(1)
    expect(port.closedCount).toBe(1)
    expect(port.listenerCount('message')).toBe(0)
    expect(port.listenerCount('close')).toBe(0)
    await expect(transport.send('after-close')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
    expect(transport.onMessage(() => {})).toBeFunction()

    // Late onClose subscriber fires via microtask unless unsubscribed first.
    let lateFired = false
    transport.onClose(() => {
      lateFired = true
    })
    let cancelledFired = false
    const offCancelled = transport.onClose(() => {
      cancelledFired = true
    })
    offCancelled()

    expect(lateFired).toBe(false)
    await Promise.resolve()
    expect(lateFired).toBe(true)
    expect(cancelledFired).toBe(false)
  })

  test('works with Worker-like ports omitting optional start() and close()', async () => {
    const listeners = new Map<string, Set<(event: any) => void>>()
    const posted: unknown[] = []

    const workerLike: MessagePortLike = {
      postMessage(message) {
        posted.push(message)
      },
      addEventListener(type, listener) {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(listener)
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener)
      },
    }

    const transport = portTransport(workerLike)
    const received: string[] = []
    const offMsg = transport.onMessage((msg) => received.push(msg))

    await transport.send('hello-worker')
    expect(posted).toEqual(['hello-worker'])

    for (const listener of listeners.get('message') ?? []) {
      listener({ data: 'from-worker' })
    }
    expect(received).toEqual(['from-worker'])

    offMsg()
    for (const listener of listeners.get('message') ?? []) {
      listener({ data: 'ignored-after-unsub' })
    }
    expect(received).toEqual(['from-worker'])

    let closed = 0
    transport.onClose(() => {
      closed++
    })
    transport.close()
    expect(closed).toBe(1)
    expect(listeners.get('message')?.size ?? 0).toBe(0)
  })

  test('decodes string, structured object/array, ArrayBuffer, and Uint8Array payloads', () => {
    const port = new MockPort()
    const transport = portTransport(port)
    const received: string[] = []
    transport.onMessage((msg) => received.push(msg))

    const utf8 = '你好 🚀 café'
    const encoded = new TextEncoder().encode(utf8)
    const ab = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )
    const padded = new Uint8Array(encoded.byteLength + 4)
    padded.set(encoded, 2)

    port.emit('message', { data: 'raw-string' })
    port.emit('message', {
      data: { jsonrpc: '2.0', id: 1, method: 'ping' },
    })
    port.emit('message', { data: [{ jsonrpc: '2.0', method: 'notify' }] })
    port.emit('message', { data: ab })
    port.emit('message', {
      data: padded.subarray(2, 2 + encoded.byteLength),
    })

    // Undefined and unserializable circular payloads are safely ignored.
    port.emit('message', { data: undefined })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    port.emit('message', { data: circular })

    expect(received).toEqual([
      'raw-string',
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      '[{"jsonrpc":"2.0","method":"notify"}]',
      utf8,
      utf8,
    ])

    transport.close()
  })

  test('wraps postMessage errors in KrpcTransportError and handles remote close event', async () => {
    const port = new MockPort()
    const transport = portTransport(port)

    port.throwOnPost = true
    await expect(transport.send('boom')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
    port.throwOnPost = false

    const reasons: unknown[] = []
    const offIgnored = transport.onClose(() => {
      reasons.push('ignored')
    })
    offIgnored()
    transport.onClose((reason) => reasons.push(reason))

    const closeEvent = { type: 'close' }
    port.emit('close', closeEvent)
    port.emit('message', { data: 'after-close' })

    expect(reasons).toEqual([closeEvent])
    expect(port.listenerCount('message')).toBe(0)
    expect(port.listenerCount('close')).toBe(0)
  })
})

describe('portTransport (real Web Standard MessageChannel)', () => {
  test('delivers raw string and structured payloads bidirectionally over MessageChannel', async () => {
    const { port1, port2 } = new MessageChannel()
    const t1 = portTransport(port1)
    const t2 = portTransport(port2)

    const received1: string[] = []
    const received2: string[] = []

    const got1 = new Promise<void>((resolve) => {
      t1.onMessage((msg) => {
        received1.push(msg)
        if (received1.length === 2) resolve()
      })
    })
    const got2 = new Promise<void>((resolve) => {
      t2.onMessage((msg) => {
        received2.push(msg)
        if (received2.length === 2) resolve()
      })
    })

    await t1.send('hello-port2-你好 🚀')
    port1.postMessage({
      jsonrpc: '2.0',
      method: 'structured',
      params: { n: 1 },
    })

    await t2.send('hello-port1')
    port2.postMessage([{ jsonrpc: '2.0', id: 1, result: 'ok' }])

    await Promise.all([got1, got2])

    expect(received2).toEqual([
      'hello-port2-你好 🚀',
      '{"jsonrpc":"2.0","method":"structured","params":{"n":1}}',
    ])
    expect(received1).toEqual([
      'hello-port1',
      '[{"jsonrpc":"2.0","id":1,"result":"ok"}]',
    ])

    t1.close()
    t2.close()
  })

  test('supports full bidirectional createPeer RPC, ctx.notify, peer.on, batch, and errors over MessageChannel', async () => {
    const JobFailed = defineError(-32010, 'Job failed').data<{
      jobId: string
    }>()

    const workerApp = defineService(() => {
      const progress = defineNotify<{ jobId: string; percent: number }>()
      const ready = defineNotify<{ version: string }>()

      const runJob = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
        if (jobId === 'bad') {
          return JobFailed({ jobId })
        }
        await ctx.notify(progress, { jobId, percent: 25 })
        await ctx.notify(progress, { jobId, percent: 100 })
        return { jobId, status: 'done' as const }
      })

      const sum = defineMethod(({ a, b }: { a: number; b: number }) => a + b)

      return { progress, ready, runJob, sum }
    })

    const mainApp = defineService(() => ({
      getConfig: defineMethod(() => ({ env: 'production' as const })),
    }))

    const { port1, port2 } = new MessageChannel()
    const mainPeer = createPeer<typeof workerApp, typeof mainApp>(
      portTransport(port1),
      mainApp
    )
    const workerPeer = createPeer<typeof mainApp, typeof workerApp>(
      portTransport(port2),
      workerApp
    )

    try {
      // Subscribe to push notifications from workerPeer.
      const progressEvents: Array<{ jobId: string; percent: number }> = []
      const readyEvents: Array<{ version: string }> = []

      const gotReady = new Promise<void>((resolve) => {
        mainPeer.on('ready', (payload) => {
          readyEvents.push(payload)
          resolve()
        })
      })

      const offProgress = mainPeer.on('progress', (payload) => {
        progressEvents.push(payload)
      })

      // Direct server-to-client push notification.
      await workerPeer.notify('ready', { version: '1.0.0' })
      await gotReady
      expect(readyEvents).toEqual([{ version: '1.0.0' }])

      // Concurrent bidirectional calls in both directions + ctx.notify!
      const [jobResult, errorResult, configResult, batchResult] =
        await Promise.all([
          mainPeer.call('runJob', { jobId: 'j1' }),
          mainPeer.call('runJob', { jobId: 'bad' }),
          workerPeer.call('getConfig'),
          mainPeer.batch((b) => [
            b.call('sum', { a: 2, b: 3 }),
            b.call('sum', { a: 10, b: 20 }),
          ]),
        ])

      expect(jobResult).toEqual({
        ok: true,
        value: { jobId: 'j1', status: 'done' },
      })
      expect(errorResult).toEqual({
        ok: false,
        error: { code: -32010, message: 'Job failed', data: { jobId: 'bad' } },
      })
      expect(configResult).toEqual({
        ok: true,
        value: { env: 'production' },
      })
      expect(batchResult).toEqual([
        { ok: true, value: 5 },
        { ok: true, value: 30 },
      ])
      expect(progressEvents).toEqual([
        { jobId: 'j1', percent: 25 },
        { jobId: 'j1', percent: 100 },
      ])

      offProgress()
    } finally {
      await mainPeer.close()
      await workerPeer.close()
    }
  })
})
