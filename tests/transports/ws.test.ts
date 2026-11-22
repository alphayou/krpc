import { describe, expect, test } from 'bun:test'
import { createPeer } from '../../src/peer/peer'
import { JsonRpcError, KrpcTransportError } from '../../src/protocol/errors'
import { createServer, type ServerConnection } from '../../src/server/server'
import { defineContext } from '../../src/service/context'
import { defineMethod, defineNotify } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import { isDuplexTransport } from '../../src/transports/types'
import {
  createWsHandler,
  createWsServerTransport,
  wsTransport,
  type ServerWebSocketLike,
  type WebSocketLike,
  type WsServerTransportBridge,
} from '../../src/transports/ws'

class MockWebSocket implements WebSocketLike {
  readyState: number
  sent: string[] = []
  closedCount = 0
  private listeners = new Map<string, Set<(event: any) => void>>()

  constructor(initialState = 0) {
    this.readyState = initialState
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('Socket is not open')
    }
    this.sent.push(data)
  }

  close(): void {
    this.closedCount++
    this.readyState = 3
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

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  emit(type: string, event?: unknown): void {
    if (type === 'open') {
      this.readyState = 1
    } else if (type === 'close') {
      this.readyState = 3
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event)
    }
  }
}

describe('isDuplexTransport', () => {
  test('validates DuplexTransport shape', () => {
    const socket = new MockWebSocket(1)
    const client = wsTransport(socket)
    const server = createWsServerTransport({ send() {}, close() {} }).transport

    expect(isDuplexTransport(client)).toBe(true)
    expect(isDuplexTransport(server)).toBe(true)
    expect(isDuplexTransport(null)).toBe(false)
    expect(isDuplexTransport(undefined)).toBe(false)
    expect(isDuplexTransport(() => {})).toBe(false)
    expect(isDuplexTransport({ send() {}, onMessage() {} })).toBe(false)
  })
})

describe('wsTransport (unit)', () => {
  test('queues outbound sends while CONNECTING and flushes in FIFO order on open', async () => {
    const socket = new MockWebSocket(0)
    const transport = wsTransport(socket)

    const p1 = transport.send('{"id":1}')
    const p2 = transport.send('{"id":2}')
    expect(socket.sent).toEqual([])

    socket.emit('open')
    await Promise.all([p1, p2])

    expect(socket.sent).toEqual(['{"id":1}', '{"id":2}'])
    await transport.send('{"id":3}')
    expect(socket.sent).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  test('rejects queued sends if socket closes before opening', async () => {
    const socket = new MockWebSocket(0)
    const transport = wsTransport(socket)

    const closeReasons: unknown[] = []
    transport.onClose((reason) => closeReasons.push(reason))

    const p1 = transport.send('{"id":1}')
    const p2 = transport.send('{"id":2}')
    const closeEvent = { code: 1006, reason: 'connection refused' }
    socket.emit('close', closeEvent)

    await expect(p1).rejects.toBeInstanceOf(KrpcTransportError)
    await expect(p2).rejects.toBeInstanceOf(KrpcTransportError)
    expect(closeReasons).toEqual([closeEvent])
    expect(socket.listenerCount('open')).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
  })

  test('rejects queued sends when transport.close() is called while CONNECTING', async () => {
    const socket = new MockWebSocket(0)
    const transport = wsTransport(socket)

    let closeCalls = 0
    transport.onClose(() => {
      closeCalls++
    })

    const pending = transport.send('{"id":1}')
    transport.close()
    // Calling close again or receiving late close event must not emit twice.
    transport.close()
    socket.emit('close', { code: 1000 })

    await expect(pending).rejects.toBeInstanceOf(KrpcTransportError)
    expect(closeCalls).toBe(1)
    expect(socket.closedCount).toBe(1)
  })

  test('decodes string, ArrayBuffer, Uint8Array (with byteOffset), and Blob frames', async () => {
    const socket = new MockWebSocket(1)
    const transport = wsTransport(socket)
    const received: string[] = []
    const off = transport.onMessage((msg) => received.push(msg))

    const encoder = new TextEncoder()
    const payloadUtf8 = '你好 🚀 café'
    const encoded = encoder.encode(payloadUtf8)

    // String frame
    socket.emit('message', { data: 'plain-text' })

    // ArrayBuffer frame
    const ab = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )
    socket.emit('message', { data: ab })

    // Uint8Array subarray with non-zero byteOffset
    const padded = new Uint8Array(encoded.byteLength + 4)
    padded.set([0x41, 0x42], 0)
    padded.set(encoded, 2)
    padded.set([0x43, 0x44], 2 + encoded.byteLength)
    socket.emit('message', {
      data: padded.subarray(2, 2 + encoded.byteLength),
    })

    // Blob frame
    socket.emit('message', { data: new Blob(['blob-frame']) })
    await Bun.sleep(10)

    expect(received).toEqual([
      'plain-text',
      payloadUtf8,
      payloadUtf8,
      'blob-frame',
    ])

    // Unsubscribe stops further delivery
    off()
    socket.emit('message', { data: 'ignored' })
    expect(received).toHaveLength(4)
  })

  test('rejects send() after close and notifies late onClose subscribers via microtask', async () => {
    const socket = new MockWebSocket(3)
    const transport = wsTransport(socket)

    await expect(transport.send('nope')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
    expect(transport.onMessage(() => {})).toBeFunction()

    let notified = false
    transport.onClose(() => {
      notified = true
    })
    let cancelled = false
    const offCancelled = transport.onClose(() => {
      cancelled = true
    })
    offCancelled()

    expect(notified).toBe(false)
    await Promise.resolve()
    expect(notified).toBe(true)
    expect(cancelled).toBe(false)
  })

  test('wraps socket.send() errors during open flush and open sends in KrpcTransportError', async () => {
    const socket = new MockWebSocket(0)
    socket.send = () => {
      throw new Error('boom')
    }
    const transport = wsTransport(socket)

    const queued = transport.send('queued')
    socket.emit('open')
    await expect(queued).rejects.toBeInstanceOf(KrpcTransportError)
    await expect(transport.send('direct')).rejects.toBeInstanceOf(
      KrpcTransportError
    )

    let closeCalled = false
    const offClose = transport.onClose(() => {
      closeCalled = true
    })
    offClose()
    transport.close()
    expect(closeCalled).toBe(false)
  })

  test('isolates throwing onMessage and onClose listeners without breaking sibling listeners or socket.close()', () => {
    const socket = new MockWebSocket(1)
    const transport = wsTransport(socket)

    const received: string[] = []
    transport.onMessage(() => {
      throw new Error('bad message listener')
    })
    transport.onMessage((msg) => {
      received.push(msg)
    })

    socket.emit('message', { data: 'first' })
    socket.emit('message', { data: 'second' })
    expect(received).toEqual(['first', 'second'])

    let siblingClosed = 0
    transport.onClose(() => {
      throw new Error('bad close listener')
    })
    transport.onClose(() => {
      siblingClosed++
    })

    transport.close()
    expect(siblingClosed).toBe(1)
    expect(socket.closedCount).toBe(1)
  })
})

describe('createWsServerTransport (unit)', () => {
  test('bridges send, binary/string decode, close(), and error wrapping', async () => {
    const sent: string[] = []
    let closeCalls = 0
    let shouldThrow = false
    const mockWs: ServerWebSocketLike = {
      send(data) {
        if (shouldThrow) {
          throw new Error('write failed')
        }
        sent.push(data)
        return data.length
      },
      close() {
        closeCalls++
      },
    }

    const bridge = createWsServerTransport(mockWs)
    const received: string[] = []
    const closes: unknown[] = []

    const offMsg = bridge.transport.onMessage((msg) => received.push(msg))
    const offClose = bridge.transport.onClose((reason) => closes.push(reason))

    await bridge.transport.send('{"ok":true}')
    expect(sent).toEqual(['{"ok":true}'])

    shouldThrow = true
    await expect(bridge.transport.send('fail')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
    shouldThrow = false

    const bytes = new TextEncoder().encode('binary-你好-🎉')
    bridge.handleMessage('text-frame')
    bridge.handleMessage(bytes)
    bridge.handleMessage(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    )
    expect(received).toEqual(['text-frame', 'binary-你好-🎉', 'binary-你好-🎉'])

    offMsg()
    bridge.handleMessage('unsubscribed')
    expect(received).toHaveLength(3)

    offClose()
    let activeClose = 0
    bridge.transport.onClose(() => {
      activeClose++
    })

    bridge.transport.close()
    bridge.transport.close()
    bridge.handleClose('duplicate-close')
    bridge.handleMessage('after-close')

    expect(closes).toEqual([])
    expect(activeClose).toBe(1)
    expect(closeCalls).toBe(1)
    expect(bridge.transport.onMessage(() => {})).toBeFunction()
    await expect(bridge.transport.send('after-close')).rejects.toBeInstanceOf(
      KrpcTransportError
    )

    let lateNotified = false
    bridge.transport.onClose(() => {
      lateNotified = true
    })
    await Promise.resolve()
    expect(lateNotified).toBe(true)
  })

  test('isolates throwing onMessage and onClose listeners on server bridge', () => {
    let closeCalls = 0
    const bridge = createWsServerTransport({
      send() {},
      close() {
        closeCalls++
      },
    })

    const received: string[] = []
    bridge.transport.onMessage(() => {
      throw new Error('msg boom')
    })
    bridge.transport.onMessage((msg) => received.push(msg))

    bridge.handleMessage('hello')
    expect(received).toEqual(['hello'])

    let siblingClosed = 0
    bridge.transport.onClose(() => {
      throw new Error('close boom')
    })
    bridge.transport.onClose(() => {
      siblingClosed++
    })

    bridge.transport.close()
    expect(siblingClosed).toBe(1)
    expect(closeCalls).toBe(1)
  })
})

describe('wsTransport + createWsServerTransport (Bun.serve e2e)', () => {
  test('end-to-end bidirectional text & binary frames, CONNECTING queue, and close cleanup', async () => {
    const bridges = new WeakMap<object, WsServerTransportBridge>()
    const serverReceived: string[] = []
    let serverClosedCount = 0

    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) {
          return undefined
        }
        return new Response('upgrade required', { status: 426 })
      },
      websocket: {
        open(ws) {
          const bridge = createWsServerTransport(ws)
          bridges.set(ws, bridge)
          bridge.transport.onMessage((msg) => {
            serverReceived.push(msg)
            if (msg === 'send-binary') {
              ws.send(new TextEncoder().encode('binary-reply-🚀'))
            } else {
              void bridge.transport.send(`echo:${msg}`)
            }
          })
          bridge.transport.onClose(() => {
            serverClosedCount++
          })
        },
        message(ws, data) {
          bridges.get(ws)?.handleMessage(data)
        },
        close(ws, code, reason) {
          bridges.get(ws)?.handleClose({ code, reason })
        },
      },
    })

    try {
      const url = `ws://127.0.0.1:${server.port}`
      const socket = new WebSocket(url)
      const client = wsTransport(socket)

      const clientReceived: string[] = []
      let clientClosedCount = 0
      const allReplies = new Promise<void>((resolve) => {
        client.onMessage((msg) => {
          clientReceived.push(msg)
          if (clientReceived.length === 3) {
            resolve()
          }
        })
      })
      const clientClosed = new Promise<void>((resolve) => {
        client.onClose(() => {
          clientClosedCount++
          resolve()
        })
      })

      // Send while WebSocket is still CONNECTING (readyState === 0)
      expect(socket.readyState).toBe(WebSocket.CONNECTING)
      const p1 = client.send('queued-1')
      const p2 = client.send('queued-2-你好')
      const p3 = client.send('send-binary')

      await Promise.all([p1, p2, p3])
      await allReplies

      expect(serverReceived).toEqual([
        'queued-1',
        'queued-2-你好',
        'send-binary',
      ])
      expect(clientReceived).toEqual([
        'echo:queued-1',
        'echo:queued-2-你好',
        'binary-reply-🚀',
      ])

      client.close()
      await clientClosed
      await Bun.sleep(30)

      expect(clientClosedCount).toBe(1)
      expect(serverClosedCount).toBe(1)
    } finally {
      await server.stop(true)
    }
  })
})

describe('createWsHandler', () => {
  test('manages lifecycle, id, setupContext, onOpen, onClose, and idempotent close', async () => {
    const Role = defineContext<string>()
    const notice = defineNotify<{ text: string }>()
    const app = defineService(() => ({
      notice,
      whoami: defineMethod((_params: void, ctx) => ({
        id: ctx.clientId,
        role: ctx.get(Role),
      })),
    }))
    const rpcServer = createServer(app)

    interface MockSocket extends ServerWebSocketLike {
      readonly role: string
      readonly userId: string
      readonly sent: string[]
      closedCount: number
    }

    const opened: Array<{ id: string; role: string }> = []
    const closed: Array<{ id: string; reason: unknown }> = []
    let latestConn: ServerConnection<typeof app> | undefined

    const handler = createWsHandler<typeof app, MockSocket>(rpcServer, {
      id: (ws) => ws.userId,
      setupContext(ctx, ws) {
        ctx.set(Role, ws.role)
      },
      onOpen(conn, ws) {
        latestConn = conn
        opened.push({ id: conn.id, role: ws.role })
      },
      onClose(conn, _ws, reason) {
        closed.push({ id: conn.id, reason })
      },
    })

    const ws1: MockSocket = {
      role: 'admin',
      userId: 'u-1',
      sent: [],
      closedCount: 0,
      send(data) {
        this.sent.push(data)
      },
      close() {
        this.closedCount++
      },
    }

    // Unknown socket calls are safely ignored
    handler.message(ws1, '{"jsonrpc":"2.0","id":0,"method":"whoami"}')
    handler.close(ws1, 1000, 'unknown')
    expect(ws1.sent).toEqual([])
    expect(closed).toEqual([])

    handler.open(ws1)
    expect(opened).toEqual([{ id: 'u-1', role: 'admin' }])

    handler.message(
      ws1,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'whoami' })
    )
    await Bun.sleep(10)
    expect(ws1.sent).toEqual([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { id: 'u-1', role: 'admin' },
      }),
    ])

    expect(await rpcServer.notify('u-1', 'notice', { text: 'hello' })).toBe(
      true
    )
    expect(await latestConn!.notify(notice, { text: 'direct' })).toBe(true)
    expect(ws1.sent).toHaveLength(3)

    // Peer-initiated close fires onClose once with code/reason and unregisters from server
    handler.close(ws1, 1000, 'bye')
    handler.close(ws1, 1000, 'duplicate')
    expect(closed).toEqual([
      { id: 'u-1', reason: { code: 1000, reason: 'bye' } },
    ])
    expect(
      await rpcServer.notify('u-1', 'notice', { text: 'after-close' })
    ).toBe(false)

    // Server-initiated conn.close() also triggers onClose once even if handler.close runs later
    const ws2: MockSocket = {
      role: 'guest',
      userId: 'u-2',
      sent: [],
      closedCount: 0,
      send(data) {
        this.sent.push(data)
      },
      close() {
        this.closedCount++
      },
    }
    handler.open(ws2)
    await latestConn!.close()
    handler.close(ws2, 1000, '')
    expect(ws2.closedCount).toBe(1)
    expect(closed).toEqual([
      { id: 'u-1', reason: { code: 1000, reason: 'bye' } },
      { id: 'u-2', reason: undefined },
    ])
  })

  test('works directly as Bun.serve({ websocket }) handler', async () => {
    const pingEvent = defineNotify<{ from: string }>()
    const app = defineService(() => ({
      pingEvent,
      info: defineMethod((_params: void, ctx) => ({ clientId: ctx.clientId })),
    }))
    const rpcServer = createServer(app)

    let closedEvent: { id: string; reason: unknown } | undefined
    let onCloseResolve!: () => void
    const closeDone = new Promise<void>((resolve) => {
      onCloseResolve = resolve
    })

    const bunServer = Bun.serve<{ clientId?: string }>({
      port: 0,
      fetch(req, srv) {
        const clientId = new URL(req.url).searchParams.get('id') ?? undefined
        if (srv.upgrade(req, { data: { clientId } })) {
          return undefined
        }
        return new Response('Upgrade required', { status: 426 })
      },
      websocket: createWsHandler(rpcServer, {
        id: (ws) => ws.data?.clientId,
        onClose(conn, _ws, reason) {
          closedEvent = { id: conn.id, reason }
          onCloseResolve()
        },
      }),
    })

    try {
      const peer = createPeer<typeof app>(
        wsTransport(new WebSocket(`ws://127.0.0.1:${bunServer.port}?id=ws-42`))
      )

      const received: Array<{ from: string }> = []
      const pushed = new Promise<void>((resolve) => {
        peer.on('pingEvent', (payload) => {
          received.push(payload)
          resolve()
        })
      })

      expect(await peer.call('info')).toEqual({
        ok: true,
        value: { clientId: 'ws-42' },
      })
      expect(
        await rpcServer.notify('ws-42', 'pingEvent', { from: 'server' })
      ).toBe(true)
      await pushed
      expect(received).toEqual([{ from: 'server' }])

      await peer.close()
      await closeDone
      expect(closedEvent?.id).toBe('ws-42')
      expect(closedEvent?.reason).toBeDefined()
    } finally {
      await bunServer.stop(true)
    }
  })

  test('isolates throwing setupContext without breaking the WebSocket message loop', async () => {
    const app = defineService(() => ({
      ping: defineMethod(() => 'pong' as const),
    }))
    const rpcServer = createServer(app)
    let mode: 'auth' | 'boom' | 'ok' = 'auth'

    const handler = createWsHandler(rpcServer, {
      async setupContext() {
        if (mode === 'auth') throw new JsonRpcError(-32001, 'Auth failed')
        if (mode === 'boom') throw new Error('unexpected secret')
      },
    })

    const sent: string[] = []
    const mockWs: ServerWebSocketLike = {
      send(data) {
        sent.push(data)
      },
      close() {},
    }

    handler.open(mockWs)
    handler.message(
      mockWs,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    )
    await Bun.sleep(10)

    mode = 'boom'
    handler.message(
      mockWs,
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
    )
    await Bun.sleep(10)

    mode = 'ok'
    handler.message(
      mockWs,
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })
    )
    await Bun.sleep(10)

    expect(sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32001, message: 'Auth failed' },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32603, message: 'Internal error' },
      },
      { jsonrpc: '2.0', id: 3, result: 'pong' },
    ])
    handler.close(mockWs, 1000, 'done')
  })
})
