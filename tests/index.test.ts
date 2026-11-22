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
    await ctx.notify(progress, { jobId, percent: 50 })
    await ctx.notify(done, { jobId })
    return { started: jobId, locale: ctx.get(Locale) }
  })

  const startEarly = defineMethod(({ jobId }: { jobId: string }, ctx) => {
    ctx.after(async () => {
      await ctx.notify(done, { jobId })
    })
    return { accepted: jobId, clientId: ctx.clientId ?? null }
  })

  const notifyTarget = defineMethod(
    async ({ targetId, jobId }: { targetId: string; jobId: string }, ctx) => {
      return { delivered: await ctx.notify(done, { jobId }, targetId) }
    }
  )

  return { progress, done, start, startEarly, notifyTarget }
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
  noop: defineMethod(() => {}),
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
    expect(await rpc.noop()).toEqual({ ok: true, value: null })
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

      // Void handler must serialize explicit `"result": null` over HTTP
      expect(await authClient.call('noop')).toEqual({ ok: true, value: null })
      const rawNoopRes = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'noop' }),
      })
      expect(await rawNoopRes.text()).toBe(
        '{"jsonrpc":"2.0","id":99,"result":null}'
      )

      // Untyped client works against external JSON-RPC 2.0 HTTP endpoints
      const untypedClient = createClient(httpTransport(url))
      expect(await untypedClient.call('math.sum', [10, 20])).toEqual({
        ok: true,
        value: 30,
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

      // Void handler round-trip over real WebSocket
      expect(await clientPeer.call('noop')).toEqual({ ok: true, value: null })

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
      expect(await clientPeer.call('noop')).toEqual({ ok: true, value: null })
      expect(await clientPeer.call('job.start', { jobId: framing })).toEqual({
        ok: true,
        value: { started: framing, locale: 'en-US' },
      })
      expect(pushed).toEqual([{ jobId: framing, percent: 50 }])

      await clientPeer.close()
      await serverPeer.close()
    }
  })

  it('supports untyped createPeer against external duplex JSON-RPC 2.0 servers', async () => {
    const aToB = new TransformStream<Uint8Array, Uint8Array>()
    const bToA = new TransformStream<Uint8Array, Uint8Array>()

    const serverPeer = createPeer(
      streamTransport({ readable: aToB.readable, writable: bToA.writable }),
      app
    )
    const untypedPeer = createPeer(
      streamTransport({ readable: bToA.readable, writable: aToB.writable })
    )

    const seen: unknown[] = []
    untypedPeer.on('job.progress', (payload) => {
      seen.push(payload)
    })

    expect(await untypedPeer.call('ping')).toEqual({ ok: true, value: 'pong' })
    expect(await untypedPeer.call('job.start', { jobId: 'ext-1' })).toEqual({
      ok: true,
      value: { started: 'ext-1', locale: 'en-US' },
    })
    expect(seen).toEqual([{ jobId: 'ext-1', percent: 50 }])

    await untypedPeer.close()
    await serverPeer.close()
  })

  it('bridges HTTP requests and WebSocket connections on one RpcServer via server.connect, server.notify, and ctx.after', async () => {
    interface WsData {
      bridge?: WsServerTransportBridge
    }

    const rpcServer = createServer(app)
    const httpHandler = createHttpHandler(rpcServer)

    const bunServer = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === '/ws') {
          if (srv.upgrade(req, { data: {} })) {
            return undefined
          }
          return new Response('Upgrade required', { status: 426 })
        }
        return httpHandler(req)
      },
      websocket: {
        open(ws) {
          const bridge = createWsServerTransport(ws)
          ws.data.bridge = bridge
          rpcServer.connect(bridge.transport, 'user-1')
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
      const ws = new WebSocket(`ws://127.0.0.1:${bunServer.port}/ws`)
      const wsClient = createPeer<App>(wsTransport(ws))
      const httpClient = createClient<App>(
        httpTransport(`http://127.0.0.1:${bunServer.port}/rpc`)
      )

      const events: string[] = []
      wsClient.on('job.done', ({ jobId }) => {
        events.push(`done:${jobId}`)
      })

      // 1. Early reply over real WebSocket via server.connect guarantees response before notify
      const earlyRes = await wsClient.call('job.startEarly', {
        jobId: 'ws-early',
      })
      events.push(
        `reply:${earlyRes.ok ? `${earlyRes.value.accepted}:${earlyRes.value.clientId}` : 'err'}`
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(events).toEqual(['reply:ws-early:user-1', 'done:ws-early'])

      // 2. HTTP call silently drops untargeted ctx.notify and delivers targeted ctx.notify to WS user-1
      expect(
        await httpClient.call('job.start', { jobId: 'http-silent' })
      ).toEqual({
        ok: true,
        value: { started: 'http-silent', locale: 'en-US' },
      })
      expect(
        await httpClient.call('job.notifyTarget', {
          targetId: 'user-1',
          jobId: 'from-http',
        })
      ).toEqual({ ok: true, value: { delivered: true } })
      expect(
        await httpClient.call('job.notifyTarget', {
          targetId: 'offline-user',
          jobId: 'missed',
        })
      ).toEqual({ ok: true, value: { delivered: false } })
      await new Promise((r) => setTimeout(r, 20))
      expect(events).toEqual([
        'reply:ws-early:user-1',
        'done:ws-early',
        'done:from-http',
      ])

      // 3. Direct server.notify pushes to WS user-1
      expect(
        await rpcServer.notify('user-1', 'job.done', { jobId: 'direct' })
      ).toBe(true)
      await new Promise((r) => setTimeout(r, 20))
      expect(events).toContain('done:direct')

      await wsClient.close()
    } finally {
      bunServer.stop(true)
    }
  })
})
