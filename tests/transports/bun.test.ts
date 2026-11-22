import { describe, expect, test } from 'bun:test'
import { createBunHandler } from '../../src/bun'
import { createHttpHandler, httpTransport } from '../../src/http'
import {
  createClient,
  createPeer,
  createServer,
  defineContext,
  defineError,
  defineMethod,
  defineNotify,
  defineService,
  onBefore,
  type ServerConnection,
} from '../../src/index'
import { wsTransport } from '../../src/ws'

const AuthHeader = defineContext<string>()
const Unauthorized = defineError(-32001, 'Unauthorized')

function createTestApp() {
  const pushed = defineNotify<{ text: string; from?: string }>()
  const done = defineNotify<{ jobId: string }>()
  const afterLog: string[] = []

  const app = defineService(() => {
    const ping = defineMethod((_params: void, ctx) => ({
      pong: true,
      clientId: ctx.clientId ?? null,
      auth: ctx.get(AuthHeader) ?? null,
    }))

    const startEarly = defineMethod(
      ({ jobId, delayMs }: { jobId: string; delayMs?: number }, ctx) => {
        ctx.after(async () => {
          if (delayMs) {
            await Bun.sleep(delayMs)
          }
          afterLog.push(`after:${jobId}`)
          await ctx.notify(done, { jobId })
        })
        return { accepted: jobId, clientId: ctx.clientId ?? null }
      }
    )

    const sendTo = defineMethod(
      async ({ targetId, text }: { targetId: string; text: string }, ctx) => ({
        delivered: await ctx.notify(
          pushed,
          { text, from: ctx.get(AuthHeader) },
          targetId
        ),
      })
    )

    const secured = defineService(() => {
      onBefore((ctx) => {
        if (ctx.get(AuthHeader) !== 'Bearer secret') {
          return Unauthorized()
        }
      })
      const secret = defineMethod((_params: void, ctx) => ({
        ok: true,
        clientId: ctx.clientId ?? null,
      }))
      return { secret }
    })

    return { ping, startEarly, sendTo, secured, pushed, done }
  })

  return { app, pushed, done, afterLog }
}

describe('createBunHandler', () => {
  test('serves unified HTTP + WebSocket on the same endpoint with shared setupContext, path filter, async id, ctx.notify, ctx.after, waitUntil, and lifecycle hooks', async () => {
    const { app, afterLog } = createTestApp()
    const rpcServer = createServer(app)

    const waitUntilPromises: Promise<void>[] = []
    const lifecycle: string[] = []
    let openedConn: ServerConnection<typeof app> | undefined
    let resolveClose!: () => void
    const closedDone = new Promise<void>((resolve) => {
      resolveClose = resolve
    })

    const bunServer = Bun.serve({
      port: 0,
      ...createBunHandler(rpcServer, {
        path: '/rpc',
        maxBodySize: 256,
        async id(req) {
          await Promise.resolve()
          return new URL(req.url).searchParams.get('clientId') ?? undefined
        },
        setupContext(ctx, req) {
          const auth = req.headers.get('authorization')
          if (auth) {
            ctx.set(AuthHeader, auth)
          }
        },
        waitUntil(promise) {
          waitUntilPromises.push(promise)
        },
        onOpen(conn, req) {
          openedConn = conn
          lifecycle.push(`open:${conn.id}:${new URL(req.url).pathname}`)
        },
        onClose(conn, req) {
          lifecycle.push(`close:${conn.id}:${new URL(req.url).pathname}`)
          resolveClose()
        },
      }),
    })

    try {
      const httpUrl = `http://127.0.0.1:${bunServer.port}/rpc`
      const otherUrl = `http://127.0.0.1:${bunServer.port}/other`

      // 1. Path filtering returns 404 for both HTTP and WS upgrade requests
      const notFoundHttp = await fetch(otherUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
      expect(notFoundHttp.status).toBe(404)

      const notFoundUpgrade = await fetch(otherUrl, {
        method: 'GET',
        headers: { upgrade: 'websocket' },
      })
      expect(notFoundUpgrade.status).toBe(404)

      // 2. maxBodySize forwarded to HTTP handler (413 Payload Too Large)
      const tooLarge = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTo',
          params: { targetId: 'u1', text: 'x'.repeat(500) },
        }),
      })
      expect(tooLarge.status).toBe(413)

      // 3. HTTP client with shared setupContext (unauthorized vs authorized)
      const unauthHttp = createClient<typeof app>(httpTransport(httpUrl))
      const unauthRes = await unauthHttp.call('secured.secret')
      expect(unauthRes.ok).toBe(false)
      if (!unauthRes.ok) {
        expect(Unauthorized.is(unauthRes.error)).toBe(true)
      }

      const authHttp = createClient<typeof app>(
        httpTransport(httpUrl, {
          headers: { authorization: 'Bearer secret' },
        })
      )
      expect(await authHttp.call('secured.secret')).toEqual({
        ok: true,
        value: { ok: true, clientId: null },
      })

      // 4. WebSocket client connects on the SAME /rpc endpoint with headers & async id
      const ws = new WebSocket(
        `ws://127.0.0.1:${bunServer.port}/rpc?clientId=alice`,
        {
          headers: { authorization: 'Bearer secret' },
        } as unknown as string[]
      )
      const wsPeer = createPeer<typeof app>(wsTransport(ws))

      const wsEvents: string[] = []
      let resolveDone!: () => void
      const wsDone = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      let resolvePushed!: () => void
      const wsPushed = new Promise<void>((resolve) => {
        resolvePushed = resolve
      })

      wsPeer.on('done', ({ jobId }) => {
        wsEvents.push(`done:${jobId}`)
        resolveDone()
      })
      wsPeer.on('pushed', ({ text, from }) => {
        wsEvents.push(`pushed:${text}:${from ?? ''}`)
        resolvePushed()
      })

      // Shared setupContext works on WS calls using upgrade request headers
      expect(await wsPeer.call('secured.secret')).toEqual({
        ok: true,
        value: { ok: true, clientId: 'alice' },
      })
      expect(openedConn?.id).toBe('alice')

      // 5. Early reply via ctx.after on WS guarantees response arrives before notification
      const earlyWsRes = await wsPeer.call('startEarly', { jobId: 'ws-job' })
      wsEvents.push(
        `reply:${earlyWsRes.ok ? earlyWsRes.value.accepted : 'err'}`
      )
      await wsDone
      expect(wsEvents).toEqual(['reply:ws-job', 'done:ws-job'])

      // 6. HTTP request pushes targeted ctx.notify(..., 'alice') to the WS client
      expect(
        await authHttp.call('sendTo', { targetId: 'alice', text: 'from-http' })
      ).toEqual({
        ok: true,
        value: { delivered: true },
      })
      expect(
        await authHttp.call('sendTo', { targetId: 'offline', text: 'missed' })
      ).toEqual({
        ok: true,
        value: { delivered: false },
      })
      await wsPushed
      expect(wsEvents).toContain('pushed:from-http:Bearer secret')

      // 7. Early reply via ctx.after on HTTP returns immediately and passes promise to waitUntil
      const earlyHttpRes = await authHttp.call('startEarly', {
        jobId: 'http-job',
        delayMs: 25,
      })
      expect(earlyHttpRes).toEqual({
        ok: true,
        value: { accepted: 'http-job', clientId: null },
      })
      expect(afterLog).not.toContain('after:http-job')
      expect(waitUntilPromises).toHaveLength(1)
      await Promise.all(waitUntilPromises)
      expect(afterLog).toContain('after:http-job')

      // 8. Closing WS triggers onClose with upgrade Request and unregisters alice
      await wsPeer.close()
      await closedDone
      expect(lifecycle).toEqual(['open:alice:/rpc', 'close:alice:/rpc'])
      expect(await rpcServer.notify('alice', 'done', { jobId: 'late' })).toBe(
        false
      )
    } finally {
      await bunServer.stop(true)
    }
  })

  test('supports custom fetch composition and auto-generated client IDs', async () => {
    const { app } = createTestApp()
    const rpcServer = createServer(app)
    const rpc = createBunHandler(rpcServer)

    const bunServer = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/health') {
          return new Response('ok')
        }
        return rpc.fetch(req, srv)
      },
      websocket: rpc.websocket,
    })

    try {
      const health = await fetch(`http://127.0.0.1:${bunServer.port}/health`)
      expect(await health.text()).toBe('ok')

      const httpClient = createClient<typeof app>(
        httpTransport(`http://127.0.0.1:${bunServer.port}/rpc`)
      )
      expect(await httpClient.call('ping')).toEqual({
        ok: true,
        value: { pong: true, clientId: null, auth: null },
      })

      const wsPeer = createPeer<typeof app>(
        wsTransport(new WebSocket(`ws://127.0.0.1:${bunServer.port}/rpc`))
      )
      const wsPing = await wsPeer.call('ping')
      expect(wsPing.ok).toBe(true)
      if (wsPing.ok) {
        expect(wsPing.value.clientId).toBe('c1')
      }

      await wsPeer.close()
    } finally {
      await bunServer.stop(true)
    }
  })

  test('returns 400 when server.upgrade returns false and runs without Bun runtime APIs', async () => {
    const { app } = createTestApp()
    const rpcServer = createServer(app)
    const handler = createBunHandler(rpcServer)

    const upgradeReq = new Request('http://localhost/rpc', {
      method: 'GET',
      headers: { upgrade: 'WebSocket' },
    })
    const res = await handler.fetch(upgradeReq, {
      upgrade: () => false,
    })
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(400)
    expect(await res?.text()).toBe('WebSocket upgrade failed')

    // Non-GET upgrade header falls through to HTTP handler (405 or POST JSON-RPC)
    const postReq = new Request('http://localhost/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        upgrade: 'websocket',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    const postRes = await handler.fetch(postReq, {
      upgrade: () => true,
    })
    expect(postRes?.status).toBe(200)
    expect(await postRes?.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { pong: true, clientId: null, auth: null },
    })

    // Sanity check createHttpHandler remains independently composable
    expect(typeof createHttpHandler(rpcServer)).toBe('function')
  })
})
