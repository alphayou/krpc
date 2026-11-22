import { describe, expect, test } from 'bun:test'
import { KrpcTransportError } from '../../src/protocol/errors'
import { isDuplexTransport } from '../../src/transports/types'
import {
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
