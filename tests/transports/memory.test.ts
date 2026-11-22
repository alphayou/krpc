import { describe, expect, test } from 'bun:test'
import { KrpcTransportError } from '../../src/protocol/errors'
import { createServer } from '../../src/server/server'
import { defineContext } from '../../src/service/context'
import { defineMethod } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import {
  createMemoryDuplexPair,
  createMemoryTransport,
} from '../../src/transports/memory'
import { isDuplexTransport } from '../../src/transports/types'

const Tenant = defineContext<string>()

describe('createMemoryTransport', () => {
  test('dispatches single requests, notifications, batches, and setupContext directly in memory', async () => {
    const notifications: string[] = []
    let observedSignal: AbortSignal | undefined

    const app = defineService(() => {
      const greet = defineMethod(({ name }: { name: string }, ctx) => {
        observedSignal = ctx.signal
        return `${ctx.get(Tenant) ?? 'default'}:${name}`
      })
      const log = defineMethod(({ text }: { text: string }) => {
        notifications.push(text)
      })
      return { greet, log }
    })

    const server = createServer(app)
    const plainTransport = createMemoryTransport(server)

    const plainRes = await plainTransport({
      jsonrpc: '2.0',
      id: 1,
      method: 'greet',
      params: { name: 'world' },
    })
    expect(plainRes).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: 'default:world',
    })

    const notifyRes = await plainTransport({
      jsonrpc: '2.0',
      method: 'log',
      params: { text: 'hello' },
    })
    expect(notifyRes).toBeUndefined()
    expect(notifications).toEqual(['hello'])

    const ctxTransport = createMemoryTransport(server, {
      setupContext(ctx) {
        ctx.set(Tenant, 'acme')
      },
    })
    const controller = new AbortController()
    const batchRes = await ctxTransport(
      [
        {
          jsonrpc: '2.0',
          id: 'a',
          method: 'greet',
          params: { name: 'alice' },
        },
        {
          jsonrpc: '2.0',
          method: 'log',
          params: { text: 'batched' },
        },
      ],
      { signal: controller.signal }
    )
    expect(batchRes).toEqual([
      { jsonrpc: '2.0', id: 'a', result: 'acme:alice' },
    ])
    expect(observedSignal).toBe(controller.signal)
    expect(notifications).toEqual(['hello', 'batched'])
  })

  test('rejects immediately when AbortSignal is already aborted', async () => {
    let called = false
    const app = defineService(() => ({
      ping: defineMethod(() => {
        called = true
        return 'pong'
      }),
    }))
    const transport = createMemoryTransport(createServer(app))

    const controller = new AbortController()
    controller.abort()

    await expect(
      transport(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { signal: controller.signal }
      )
    ).rejects.toThrow()
    expect(called).toBe(false)

    const customReason = new Error('custom-cancel')
    const controller2 = new AbortController()
    controller2.abort(customReason)
    await expect(
      transport(
        { jsonrpc: '2.0', id: 2, method: 'ping' },
        { signal: controller2.signal }
      )
    ).rejects.toBe(customReason)
  })
})

describe('createMemoryDuplexPair', () => {
  test('delivers bidirectional messages asynchronously via microtasks without synchronous re-entrancy', async () => {
    const [a, b] = createMemoryDuplexPair()
    expect(isDuplexTransport(a)).toBe(true)
    expect(isDuplexTransport(b)).toBe(true)

    const log: string[] = []
    const aReceived: string[] = []
    const bReceived: string[] = []

    const offB = b.onMessage((msg) => {
      log.push(`b:${msg}`)
      bReceived.push(msg)
      void b.send(`reply:${msg}`)
    })
    a.onMessage((msg) => {
      log.push(`a:${msg}`)
      aReceived.push(msg)
    })

    const sendPromise = a.send('ping')
    // Must not deliver synchronously before send() returns.
    log.push('after-send')
    await sendPromise
    await Promise.resolve()
    await Promise.resolve()

    expect(log).toEqual(['after-send', 'b:ping', 'a:reply:ping'])
    expect(bReceived).toEqual(['ping'])
    expect(aReceived).toEqual(['reply:ping'])

    offB()
    await a.send('ignored')
    await Promise.resolve()
    expect(bReceived).toEqual(['ping'])
  })

  test('closing either side fires onClose once on both sides and prevents further delivery', async () => {
    const [a, b] = createMemoryDuplexPair()
    let aCloses = 0
    let bCloses = 0
    let unsubscribedClosed = false
    const receivedByB: string[] = []

    a.onClose(() => {
      aCloses++
    })
    b.onClose(() => {
      bCloses++
    })
    const offClose = b.onClose(() => {
      unsubscribedClosed = true
    })
    offClose()
    b.onMessage((msg) => receivedByB.push(msg))

    // Queue a message then close synchronously before the microtask runs.
    const pendingSend = a.send('dropped-in-flight')
    a.close()
    a.close()
    b.close()
    await pendingSend

    await Promise.resolve()

    expect(aCloses).toBe(1)
    expect(bCloses).toBe(1)
    expect(unsubscribedClosed).toBe(false)
    expect(receivedByB).toEqual([])
    expect(a.onMessage(() => {})).toBeFunction()

    await expect(a.send('after-close')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
    await expect(b.send('after-close')).rejects.toBeInstanceOf(
      KrpcTransportError
    )

    let lateNotified = false
    a.onClose(() => {
      lateNotified = true
    })
    let lateCancelled = false
    const offLate = b.onClose(() => {
      lateCancelled = true
    })
    offLate()
    await Promise.resolve()

    expect(lateNotified).toBe(true)
    expect(lateCancelled).toBe(false)
  })
})
