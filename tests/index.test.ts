import { describe, expect, it } from 'bun:test'
import { createHttpHandler, httpTransport } from '../src/http'
import {
  createClient,
  createMemoryTransport,
  createPeer,
  createProxy,
  createServer,
  defineContext,
  defineError,
  defineMethod,
  defineNotify,
  defineService,
  isPlainObject,
  onBefore,
  type StandardSchemaV1,
} from '../src/index'
import { streamTransport } from '../src/stream'
import {
  createWsServerTransport,
  wsTransport,
  type WsServerTransportBridge,
} from '../src/ws'

const AuthToken = defineContext<string>()
const Locale = defineContext('en-US')
const Unauthorized = defineError(-32001, 'Unauthorized')
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
        return { issues: [{ message: 'a must be a number', path: ['a'] }] }
      }
      return {
        value: { a: value.a, b: typeof value.b === 'number' ? value.b : 1 },
      }
    },
  },
}

const receivedLogs: string[] = []

const math = defineService(() => {
  const divide = defineMethod(divideSchema, ({ a, b }) => {
    if (b === 0) return DivByZero()
    if (a > 1e6) return Overflow({ max: 1e6 })
    return a / b
  })
  const sum = defineMethod(([a, b]: [number, number]) => a + b)
  return { divide, sum }
})

const job = defineService(() => {
  const progress = defineNotify<{ jobId: string; percent: number }>()
  const done = defineNotify<{ jobId: string }>()

  const start = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
    if (ctx.canNotify) {
      await ctx.notify(progress, { jobId, percent: 50 })
      await ctx.notify(done, { jobId })
    }
    return { started: jobId, locale: ctx.get(Locale) }
  })

  return { progress, done, start }
})

const admin = defineService(() => {
  onBefore((ctx) => {
    if (ctx.get(AuthToken) !== 'secret') return Unauthorized()
  })
  const secret = defineMethod(() => 'top-secret' as const)
  return { secret }
})

const app = defineService(() => ({
  ping: defineMethod(() => 'pong' as const),
  log: defineMethod(({ message }: { message: string }) => {
    receivedLogs.push(message)
  }),
  math,
  job,
  admin,
}))

type App = typeof app

describe('krpc public API end-to-end integration', () => {
  it('works over in-memory transport with batch, proxy, errors, and hooks', async () => {
    const server = createServer(app)
    const client = createClient<App>(
      createMemoryTransport(server, {
        setupContext(ctx) {
          ctx.set(AuthToken, 'secret')
        },
      })
    )
    const rpc = createProxy(client)

    expect(await rpc.ping()).toEqual({ ok: true, value: 'pong' })
    expect(await rpc.admin.secret()).toEqual({ ok: true, value: 'top-secret' })

    const overflow = await rpc.math.divide({ a: 2e6, b: 2 })
    expect(overflow.ok).toBe(false)
    if (!overflow.ok && Overflow.is(overflow.error)) {
      expect(overflow.error.data.max).toBe(1e6)
    }

    const [divRes, sumRes, logRes] = await client.batch((b) => [
      b.call('math.divide', { a: 10, b: 2 }),
      b.call('math.sum', [4, 5]),
      b.notify('log', { message: 'memory-batch' }),
    ])
    expect(divRes).toEqual({ ok: true, value: 5 })
    expect(sumRes).toEqual({ ok: true, value: 9 })
    expect(logRes).toBeUndefined()
    expect(receivedLogs).toContain('memory-batch')
  })

  it('works end-to-end over real HTTP via Bun.serve, httpTransport, and createHttpHandler', async () => {
    const server = createServer(app)
    const fetchHandler = createHttpHandler(server, {
      setupContext(ctx, req) {
        const auth = req.headers.get('authorization')
        if (auth) ctx.set(AuthToken, auth.replace(/^Bearer /, ''))
      },
    })

    const httpServer = Bun.serve({
      port: 0,
      fetch: fetchHandler,
    })

    try {
      const url = `http://127.0.0.1:${httpServer.port}/rpc`
      const unauthClient = createClient<App>(httpTransport(url))
      const unauthRes = await unauthClient.call('admin.secret')
      expect(unauthRes.ok).toBe(false)
      if (!unauthRes.ok) {
        const error: unknown = unauthRes.error
        expect(Unauthorized.is(error)).toBe(true)
        if (Unauthorized.is(error)) {
          expect(error.code).toBe(-32001)
          expect(error.message).toBe('Unauthorized')
        }
      }

      const authClient = createClient<App>(
        httpTransport(url, {
          headers: () => ({ authorization: 'Bearer secret' }),
        })
      )
      expect(await authClient.call('admin.secret')).toEqual({
        ok: true,
        value: 'top-secret',
      })

      await authClient.notify('log', { message: 'http-notify' })
      expect(receivedLogs).toContain('http-notify')
    } finally {
      httpServer.stop(true)
    }
  })

  it('works end-to-end over real WebSocket via Bun.serve with ctx.notify, peer.notify, and peer.on', async () => {
    interface WsData {
      bridge?: WsServerTransportBridge
    }

    let activeServerPeer: ReturnType<typeof createPeer<never, App>> | undefined
    const wsServer = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) {
          return undefined
        }
        return new Response('Upgrade required', { status: 426 })
      },
      websocket: {
        open(ws) {
          const bridge = createWsServerTransport(ws)
          ws.data.bridge = bridge
          activeServerPeer = createPeer(bridge.transport, app)
        },
        message(ws, data) {
          ws.data.bridge?.handleMessage(data)
        },
        close(ws) {
          ws.data.bridge?.handleClose()
        },
      },
    })

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${wsServer.port}`)
      const clientPeer = createPeer<App>(wsTransport(ws))

      const progressEvents: Array<{ jobId: string; percent: number }> = []
      const doneEvents: Array<{ jobId: string }> = []
      clientPeer.on('job.progress', (p) => {
        progressEvents.push(p)
      })
      clientPeer.on('job.done', (d) => {
        doneEvents.push(d)
      })

      // Trigger ctx.notify inside job.start over real WebSocket
      const res = await clientPeer.call('job.start', { jobId: 'ws-1' })
      expect(res).toEqual({
        ok: true,
        value: { started: 'ws-1', locale: 'en-US' },
      })

      // Server-initiated push outside handler via serverPeer.notify
      await activeServerPeer?.notify('job.progress', {
        jobId: 'ws-1',
        percent: 100,
      })
      await new Promise((r) => setTimeout(r, 20))

      expect(progressEvents).toEqual([
        { jobId: 'ws-1', percent: 50 },
        { jobId: 'ws-1', percent: 100 },
      ])
      expect(doneEvents).toEqual([{ jobId: 'ws-1' }])

      await clientPeer.close()
    } finally {
      wsServer.stop(true)
    }
  })

  it('works end-to-end over Web Streams with both ndjson and content-length framing', async () => {
    for (const framing of ['ndjson', 'content-length'] as const) {
      const aToB = new TransformStream<Uint8Array, Uint8Array>()
      const bToA = new TransformStream<Uint8Array, Uint8Array>()

      const clientStream = streamTransport({
        readable: bToA.readable,
        writable: aToB.writable,
        framing,
      })
      const serverStream = streamTransport({
        readable: aToB.readable,
        writable: bToA.writable,
        framing,
      })

      const serverPeer = createPeer(serverStream, app)
      const clientPeer = createPeer<App>(clientStream)

      const pushed: Array<{ jobId: string; percent: number }> = []
      clientPeer.on('job.progress', (p) => {
        pushed.push(p)
      })

      expect(await clientPeer.call('math.divide', { a: 20, b: 4 })).toEqual({
        ok: true,
        value: 5,
      })
      expect(await clientPeer.call('job.start', { jobId: framing })).toEqual({
        ok: true,
        value: { started: framing, locale: 'en-US' },
      })
      expect(pushed).toEqual([{ jobId: framing, percent: 50 }])

      await clientPeer.close()
      await serverPeer.close()
    }
  })
})
