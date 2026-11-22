import { describe, expect, test } from 'bun:test'
import { defineError, KrpcTransportError } from '../../src/protocol/errors'
import { createServer } from '../../src/server/server'
import { defineContext } from '../../src/service/context'
import { defineMethod } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import { createHttpHandler, httpTransport } from '../../src/transports/http'

const AuthHeader = defineContext<string | null>()
const NotAllowed = defineError(-32001, 'Not allowed')

function createTestApp() {
  const notifications: string[] = []
  let lastSignal: AbortSignal | undefined

  const app = defineService(() => {
    const echo = defineMethod(({ message }: { message: string }, ctx) => {
      lastSignal = ctx.signal
      return {
        message,
        auth: ctx.get(AuthHeader) ?? null,
      }
    })

    const failDomain = defineMethod(() => NotAllowed('denied'))

    const notify = defineMethod(({ note }: { note: string }) => {
      notifications.push(note)
    })

    const slow = defineMethod(async (_params: void, ctx) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200)
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
      return { aborted: ctx.signal.aborted }
    })

    return { echo, failDomain, notify, slow }
  })

  return {
    app,
    notifications,
    getLastSignal: () => lastSignal,
  }
}

describe('httpTransport + createHttpHandler (Bun.serve e2e)', () => {
  test('handles 200 success/error, 204 notification/all-notification batch, setupContext, and dynamic headers', async () => {
    const { app, notifications, getLastSignal } = createTestApp()
    const server = createServer(app)
    const handler = createHttpHandler(server, {
      maxBodySize: 1024,
      setupContext(ctx, req) {
        ctx.set(AuthHeader, req.headers.get('authorization'))
      },
    })

    const bunServer = Bun.serve({
      port: 0,
      fetch: handler,
    })

    try {
      const endpoint = new URL(`http://127.0.0.1:${bunServer.port}/rpc`)
      let token = 'Bearer token-1'
      const transport = httpTransport(endpoint, {
        headers: async () => ({ authorization: token }),
      })

      // 200 success with dynamic header injected into setupContext
      const res1 = await transport({
        jsonrpc: '2.0',
        id: 1,
        method: 'echo',
        params: { message: 'hello 你好 🚀' },
      })
      expect(res1).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { message: 'hello 你好 🚀', auth: 'Bearer token-1' },
      })
      expect(getLastSignal()).toBeInstanceOf(AbortSignal)

      // 200 JSON-RPC domain error returns response object (does NOT throw)
      token = 'Bearer token-2'
      const domainErr = await transport({
        jsonrpc: '2.0',
        id: 2,
        method: 'failDomain',
      })
      expect(domainErr).toEqual({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32001, message: 'denied' },
      })

      // 204 for single Notification
      const notifyRes = await transport({
        jsonrpc: '2.0',
        method: 'notify',
        params: { note: 'one' },
      })
      expect(notifyRes).toBeUndefined()

      // 204 for all-Notification batch
      const batchNotifyRes = await transport([
        { jsonrpc: '2.0', method: 'notify', params: { note: 'two' } },
        { jsonrpc: '2.0', method: 'notify', params: { note: 'three' } },
      ])
      expect(batchNotifyRes).toBeUndefined()
      expect(notifications).toEqual(['one', 'two', 'three'])

      // 200 for mixed batch
      const mixedBatch = await transport([
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'echo',
          params: { message: 'batched' },
        },
        { jsonrpc: '2.0', method: 'notify', params: { note: 'four' } },
      ])
      expect(mixedBatch).toEqual([
        {
          jsonrpc: '2.0',
          id: 3,
          result: { message: 'batched', auth: 'Bearer token-2' },
        },
      ])
      expect(notifications).toEqual(['one', 'two', 'three', 'four'])

      // HTTP protocol errors: 405, 415, 413
      const res405 = await fetch(endpoint, { method: 'GET' })
      expect(res405.status).toBe(405)
      expect(res405.headers.get('allow')).toBe('POST')

      const res415Missing = await fetch(endpoint, {
        method: 'POST',
        body: '{}',
      })
      expect(res415Missing.status).toBe(415)

      const res415Wrong = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; x=application/json' },
        body: '{}',
      })
      expect(res415Wrong.status).toBe(415)

      // 200 with charset parameter on Content-Type
      const resCharset = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'echo',
          params: { message: 'ok' },
        }),
      })
      expect(resCharset.status).toBe(200)
      expect(await resCharset.json()).toEqual({
        jsonrpc: '2.0',
        id: 4,
        result: { message: 'ok', auth: null },
      })

      // 413 when body exceeds maxBodySize (1024 bytes) via httpTransport -> throws KrpcTransportError with status 413
      let caught: unknown
      try {
        await transport({
          jsonrpc: '2.0',
          id: 5,
          method: 'echo',
          params: { message: 'x'.repeat(2000) },
        })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(KrpcTransportError)
      expect((caught as KrpcTransportError).status).toBe(413)

      // AbortSignal passed directly to fetch without wrapping AbortError
      const controller = new AbortController()
      const slowPromise = transport(
        { jsonrpc: '2.0', id: 6, method: 'slow' },
        { signal: controller.signal }
      )
      controller.abort()

      let abortCaught: unknown
      try {
        await slowPromise
      } catch (err) {
        abortCaught = err
      }
      expect(abortCaught).not.toBeInstanceOf(KrpcTransportError)
      expect((abortCaught as Error).name).toBe('AbortError')
    } finally {
      await bunServer.stop(true)
    }
  })
})

describe('createHttpHandler streaming maxBodySize and edge cases', () => {
  test('enforces maxBodySize on streamed chunked body without Content-Length and cancels early', async () => {
    const { app } = createTestApp()
    const handler = createHttpHandler(createServer(app), { maxBodySize: 32 })

    let cancelled = false
    let pulled = 0
    const encoder = new TextEncoder()
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(encoder.encode('0123456789'))
      },
      cancel() {
        cancelled = true
      },
    })

    const req = new Request('http://localhost/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversizedStream,
    })

    const res = await handler(req)
    expect(res.status).toBe(413)
    expect(cancelled).toBe(true)
    // Stopped immediately on the 4th 10-byte chunk (40 > 32), never reading unbounded data.
    expect(pulled).toBeLessThanOrEqual(5)
  })

  test('reassembles multi-chunk UTF-8 stream within maxBodySize and handles empty body', async () => {
    const { app } = createTestApp()
    const handler = createHttpHandler(createServer(app), { maxBodySize: 256 })

    const encoder = new TextEncoder()
    const payloadBytes = encoder.encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'echo',
        params: { message: '你好 🚀 split' },
      })
    )

    // Split right in the middle of multi-byte UTF-8 characters.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payloadBytes.byteLength; i += 3) {
          controller.enqueue(
            payloadBytes.subarray(i, Math.min(i + 3, payloadBytes.byteLength))
          )
        }
        controller.close()
      },
    })

    const res = await handler(
      new Request('http://localhost/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { message: '你好 🚀 split', auth: null },
    })

    // Empty body (req.body === null) yields JSON-RPC -32700 Parse error with HTTP 200.
    const emptyRes = await handler(
      new Request('http://localhost/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
    )
    expect(emptyRes.status).toBe(200)
    expect(await emptyRes.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })

    // Empty ReadableStream body (0 chunks) & zero-length chunks yield -32700 Parse error.
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.close()
      },
    })
    const emptyStreamRes = await handler(
      new Request('http://localhost/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: emptyStream,
      })
    )
    expect(emptyStreamRes.status).toBe(200)
    expect(await emptyStreamRes.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })

    // Whitespace-only POST body yields -32700 Parse error.
    const whitespaceRes = await handler(
      new Request('http://localhost/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '   \r\n\t  ',
      })
    )
    expect(whitespaceRes.status).toBe(200)
    expect(await whitespaceRes.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
  })

  test('handles invalid Content-Length headers and Content-Type charset variations', async () => {
    const { app } = createTestApp()
    const handler = createHttpHandler(createServer(app), { maxBodySize: 128 })
    const validBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'echo',
      params: { message: 'ok' },
    })

    // Invalid Content-Length headers fall back safely to streaming byte counting.
    for (const badLen of ['abc', '-10', '12.5', '10, 20']) {
      const okRes = await handler(
        new Request('http://localhost/rpc', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': badLen,
          },
          body: validBody,
        })
      )
      expect(okRes.status).toBe(200)
      expect(await okRes.json()).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { message: 'ok', auth: null },
      })

      // Oversized body is STILL rejected with 413 despite malformed Content-Length.
      const bigRes = await handler(
        new Request('http://localhost/rpc', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': badLen,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'echo',
            params: { message: 'x'.repeat(200) },
          }),
        })
      )
      expect(bigRes.status).toBe(413)
    }

    // Spoofed small Content-Length with oversized actual body still returns 413.
    const spoofedRes = await handler(
      new Request('http://localhost/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '10',
        },
        body: 'x'.repeat(200),
      })
    )
    expect(spoofedRes.status).toBe(413)

    // Quoted/multi-param charset variations succeed; non-application/json subtypes return 415.
    for (const ct of [
      'application/json; charset="UTF-8"',
      'Application/JSON ; charset=utf-8 ; version=2',
    ]) {
      const res = await handler(
        new Request('http://localhost/rpc', {
          method: 'POST',
          headers: { 'content-type': ct },
          body: validBody,
        })
      )
      expect(res.status).toBe(200)
    }

    for (const badCt of ['application/json-rpc', 'application/problem+json']) {
      const res = await handler(
        new Request('http://localhost/rpc', {
          method: 'POST',
          headers: { 'content-type': badCt },
          body: validBody,
        })
      )
      expect(res.status).toBe(415)
    }
  })

  test('rejects invalid maxBodySize options', () => {
    const server = createServer(createTestApp().app)
    expect(() => createHttpHandler(server, { maxBodySize: 0 })).toThrow(
      RangeError
    )
    expect(() => createHttpHandler(server, { maxBodySize: -10 })).toThrow(
      RangeError
    )
    expect(() => createHttpHandler(server, { maxBodySize: 1.5 })).toThrow(
      RangeError
    )
    expect(() =>
      createHttpHandler(server, { maxBodySize: Number.NaN })
    ).toThrow(RangeError)
  })
})

describe('httpTransport unit edge cases', () => {
  test('supports static headers, credentials, empty 200 body, invalid JSON, and network errors', async () => {
    let lastInit: RequestInit | undefined
    const mockFetch: typeof fetch = (async (_input, init) => {
      lastInit = init
      return new Response('', { status: 200 })
    }) as typeof fetch

    const transport = httpTransport('http://example.test/rpc', {
      fetch: mockFetch,
      headers: { 'x-api-key': 'secret' },
      credentials: 'include',
    })

    const emptyResult = await transport({
      jsonrpc: '2.0',
      method: 'notify',
    })
    expect(emptyResult).toBeUndefined()
    expect(lastInit?.credentials).toBe('include')
    const sentHeaders = new Headers(lastInit?.headers)
    expect(sentHeaders.get('x-api-key')).toBe('secret')
    expect(sentHeaders.get('content-type')).toBe('application/json')
    expect(sentHeaders.get('accept')).toBe('application/json')

    // Invalid JSON body throws KrpcTransportError with status 200
    const badJsonTransport = httpTransport('http://example.test/rpc', {
      fetch: (async () =>
        new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    })
    let badJsonErr: unknown
    try {
      await badJsonTransport({ jsonrpc: '2.0', id: 1, method: 'ping' })
    } catch (err) {
      badJsonErr = err
    }
    expect(badJsonErr).toBeInstanceOf(KrpcTransportError)
    expect((badJsonErr as KrpcTransportError).status).toBe(200)

    // Network failure wraps in KrpcTransportError
    const networkFailTransport = httpTransport('http://example.test/rpc', {
      fetch: (async () => {
        throw new TypeError('network down')
      }) as unknown as typeof fetch,
    })
    await expect(
      networkFailTransport({ jsonrpc: '2.0', id: 1, method: 'ping' })
    ).rejects.toBeInstanceOf(KrpcTransportError)

    // Body read failure wraps in KrpcTransportError with response status
    const brokenBodyTransport = httpTransport('http://example.test/rpc', {
      fetch: (async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('stream broken')
        },
      })) as unknown as typeof fetch,
    })
    let bodyErr: unknown
    try {
      await brokenBodyTransport({ jsonrpc: '2.0', id: 1, method: 'ping' })
    } catch (err) {
      bodyErr = err
    }
    expect(bodyErr).toBeInstanceOf(KrpcTransportError)
    expect((bodyErr as KrpcTransportError).status).toBe(200)

    // Aborting while reading response.text() rethrows abort error without wrapping
    const bodyAbortController = new AbortController()
    const abortBodyTransport = httpTransport('http://example.test/rpc', {
      fetch: (async () => ({
        ok: true,
        status: 200,
        text: async () => {
          bodyAbortController.abort()
          throw new DOMException('Aborted', 'AbortError')
        },
      })) as unknown as typeof fetch,
    })
    let bodyAbortErr: unknown
    try {
      await abortBodyTransport(
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { signal: bodyAbortController.signal }
      )
    } catch (err) {
      bodyAbortErr = err
    }
    expect(bodyAbortErr).not.toBeInstanceOf(KrpcTransportError)
    expect((bodyAbortErr as Error).name).toBe('AbortError')
  })
})
