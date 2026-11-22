import { describe, expect, test } from 'bun:test'
import { KrpcTransportError } from '../../src/protocol/errors'
import {
  createContentLengthDecoder,
  createNdjsonDecoder,
  encodeContentLengthFrame,
  encodeNdjsonFrame,
  streamTransport,
  type StreamFraming,
} from '../../src/transports/stream'
import { isDuplexTransport } from '../../src/transports/types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function createConnectedPair(framing?: StreamFraming, maxMessageSize?: number) {
  const aToB = new TransformStream<Uint8Array, Uint8Array>()
  const bToA = new TransformStream<Uint8Array, Uint8Array>()

  const a = streamTransport({
    readable: bToA.readable,
    writable: aToB.writable,
    framing,
    maxMessageSize,
  })
  const b = streamTransport({
    readable: aToB.readable,
    writable: bToA.writable,
    framing,
    maxMessageSize,
  })

  return { a, b }
}

function createManualReadable(): {
  readable: ReadableStream<Uint8Array>
  push: (chunk: Uint8Array) => void
  end: () => void
  error: (err: unknown) => void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
    },
  })
  return {
    readable,
    push: (chunk) => controller.enqueue(chunk),
    end: () => controller.close(),
    error: (err) => controller.error(err),
  }
}

function createSinkWritable(): {
  writable: WritableStream<Uint8Array>
  chunks: Uint8Array[]
} {
  const chunks: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  return { writable, chunks }
}

describe('stream framing helpers', () => {
  test('ndjson handles chunk splits, sticky packets, CRLF, multi-byte UTF-8, and EOF flush', () => {
    const received: string[] = []
    const ndjson = createNdjsonDecoder((msg) => received.push(msg))

    const multi = '你好世界 🚀👨‍👩‍👧‍👦 café'
    const sticky = encoder.encode(
      `${multi}\r\n\n{"a":1}\n{"b":2}\n{"tail":true}`
    )

    // Feed 1 byte at a time to stress multi-byte UTF-8 and CRLF splits.
    for (let i = 0; i < sticky.byteLength; i++) {
      ndjson.push(sticky.subarray(i, i + 1))
    }
    ndjson.flush()

    expect(received).toEqual([multi, '{"a":1}', '{"b":2}', '{"tail":true}'])
  })

  test('ndjson enforces maxMessageSize on both complete lines and unterminated buffers', () => {
    const received: string[] = []
    const ndjson = createNdjsonDecoder((msg) => received.push(msg), 6)

    // Exact 6-byte UTF-8 message ("你好" is 6 UTF-8 bytes) succeeds.
    ndjson.push(encodeNdjsonFrame('你好'))
    expect(received).toEqual(['你好'])

    // Exact 6-byte message with CRLF also succeeds.
    ndjson.push(encoder.encode('123456\r\n'))
    expect(received).toEqual(['你好', '123456'])

    // 7-byte message exceeds maxMessageSize.
    expect(() => ndjson.push(encoder.encode('1234567\n'))).toThrow(
      KrpcTransportError
    )

    // Unterminated 7-byte chunk fails immediately without waiting for newline.
    const ndjson2 = createNdjsonDecoder(() => {}, 6)
    expect(() => ndjson2.push(encoder.encode('1234567'))).toThrow(
      KrpcTransportError
    )
  })

  test('content-length encodes exact UTF-8 byte length (not UTF-16 code units)', () => {
    const msg = '{"text":"你好 🚀"}'
    const expectedBytes = encoder.encode(msg).byteLength
    // Ensure UTF-8 byte length differs from JS UTF-16 string length.
    expect(expectedBytes).toBeGreaterThan(msg.length)

    const frame = encodeContentLengthFrame(msg)
    const text = decoder.decode(frame)
    expect(text).toBe(`Content-Length: ${expectedBytes}\r\n\r\n${msg}`)
  })

  test('content-length handles 1-byte splits, sticky frames, extra headers, and multi-byte UTF-8', () => {
    const received: string[] = []
    const cl = createContentLengthDecoder((msg) => received.push(msg))

    const msg1 = '{"emoji":"🚀🎉","cjk":"中文测试"}'
    const msg2 = '{"ok":true}'
    const body1 = encoder.encode(msg1)
    const customFrame1 = encoder.encode(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body1.byteLength}\r\n\r\n`
    )
    const frame2 = encodeContentLengthFrame(msg2)

    const combined = new Uint8Array(
      customFrame1.byteLength + body1.byteLength + frame2.byteLength
    )
    combined.set(customFrame1, 0)
    combined.set(body1, customFrame1.byteLength)
    combined.set(frame2, customFrame1.byteLength + body1.byteLength)

    // Feed 1 byte at a time across header delimiter, UTF-8 bytes, and frame boundary.
    for (let i = 0; i < combined.byteLength; i++) {
      cl.push(combined.subarray(i, i + 1))
    }
    cl.flush()

    expect(received).toEqual([msg1, msg2])
  })

  test('content-length delivers sticky frames in a single chunk', () => {
    const received: string[] = []
    const cl = createContentLengthDecoder((msg) => received.push(msg))

    const f1 = encodeContentLengthFrame('{"id":1}')
    const f2 = encodeContentLengthFrame('{"id":2}')
    const f3 = encodeContentLengthFrame('{"id":3}')
    const sticky = new Uint8Array(f1.byteLength + f2.byteLength + f3.byteLength)
    sticky.set(f1, 0)
    sticky.set(f2, f1.byteLength)
    sticky.set(f3, f1.byteLength + f2.byteLength)

    cl.push(sticky)
    cl.flush()

    expect(received).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  test('content-length enforces maxMessageSize and rejects malformed/truncated frames', () => {
    const received: string[] = []
    const cl = createContentLengthDecoder((msg) => received.push(msg), 6)

    // 6-byte UTF-8 body ("你好") succeeds at exact boundary.
    cl.push(encodeContentLengthFrame('你好'))
    expect(received).toEqual(['你好'])

    // 7-byte body fails immediately when header is parsed.
    expect(() => cl.push(encodeContentLengthFrame('1234567'))).toThrow(
      KrpcTransportError
    )

    // Missing Content-Length header.
    const missing = createContentLengthDecoder(() => {})
    expect(() =>
      missing.push(encoder.encode('Content-Type: text/plain\r\n\r\n'))
    ).toThrow(KrpcTransportError)

    // Non-numeric Content-Length header.
    const invalid = createContentLengthDecoder(() => {})
    expect(() =>
      invalid.push(encoder.encode('Content-Length: abc\r\n\r\n'))
    ).toThrow(KrpcTransportError)

    // Truncated body at EOF.
    const truncated = createContentLengthDecoder(() => {})
    truncated.push(encoder.encode('Content-Length: 10\r\n\r\nabc'))
    expect(() => truncated.flush()).toThrow(KrpcTransportError)

    // Malformed header line (missing colon) and conflicting duplicate Content-Length.
    const malformed = createContentLengthDecoder(() => {})
    expect(() =>
      malformed.push(encoder.encode('InvalidHeader\r\n\r\n'))
    ).toThrow(KrpcTransportError)

    const conflicting = createContentLengthDecoder(() => {})
    expect(() =>
      conflicting.push(
        encoder.encode('Content-Length: 2\r\nContent-Length: 3\r\n\r\nab')
      )
    ).toThrow(KrpcTransportError)

    // Oversized header without delimiter.
    const hugeHeader = createContentLengthDecoder(() => {})
    expect(() => hugeHeader.push(new Uint8Array(9000).fill(0x41))).toThrow(
      KrpcTransportError
    )

    // Oversized header arriving in a single chunk WITH delimiter is also rejected.
    const hugeHeaderDelimited = createContentLengthDecoder(() => {})
    expect(() =>
      hugeHeaderDelimited.push(
        encoder.encode(
          `X-Pad: ${'a'.repeat(9000)}\r\nContent-Length: 2\r\n\r\n{}`
        )
      )
    ).toThrow(KrpcTransportError)

    // Negative, float, empty, safe-integer overflow, and empty header name are rejected,
    // and decoder clears its queue cleanly after throwing.
    for (const badHeader of [
      'Content-Length: -5\r\n\r\n',
      'Content-Length: 12.5\r\n\r\n',
      'Content-Length: \r\n\r\n',
      'Content-Length: 999999999999999999999\r\n\r\n',
      ': 42\r\nContent-Length: 2\r\n\r\n{}',
      '   : 42\r\nContent-Length: 2\r\n\r\n{}',
    ]) {
      const dec = createContentLengthDecoder(() => {})
      expect(() => dec.push(encoder.encode(badHeader))).toThrow(
        KrpcTransportError
      )
      expect(() => dec.flush()).not.toThrow()
    }

    // LSP-style multi-header block with case-insensitive CONTENT-LENGTH and 0-byte body.
    const lspReceived: string[] = []
    const lspDec = createContentLengthDecoder((msg) => lspReceived.push(msg))
    lspDec.push(new Uint8Array(0))
    const lspBody = '{"jsonrpc":"2.0","id":0,"method":"ping"}'
    lspDec.push(
      encoder.encode(
        `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: ${lspBody.length}\r\n\r\n${lspBody}` +
          'Content-Length: 0\r\n\r\n'
      )
    )
    lspDec.flush()
    expect(lspReceived).toEqual([lspBody, ''])
  })

  test('covers empty chunks, ByteQueue compaction, and ndjson trailing CR flush', () => {
    const received: string[] = []
    const ndjson = createNdjsonDecoder((msg) => received.push(msg), 10)
    ndjson.push(new Uint8Array(0))
    ndjson.push(encoder.encode('hello\r'))
    ndjson.flush()
    expect(received).toEqual(['hello'])

    // Trailing bare CR flushes cleanly without emitting empty message
    ndjson.push(encoder.encode('\r'))
    ndjson.flush()
    expect(received).toEqual(['hello'])

    // Trigger ByteQueue in-place compaction (readOffset >= capacity / 2, remaining > 0)
    const compactReceived: string[] = []
    const cl = createContentLengthDecoder((msg) => compactReceived.push(msg))
    const first = encodeContentLengthFrame('a'.repeat(3000))
    const second = encodeContentLengthFrame('b'.repeat(600))
    const third = encodeContentLengthFrame('c'.repeat(600))
    const combined = new Uint8Array(first.byteLength + 10)
    combined.set(first, 0)
    combined.set(second.subarray(0, 10), first.byteLength)
    cl.push(combined)
    cl.push(second.subarray(10))
    cl.push(third)
    cl.flush()
    expect(compactReceived).toEqual([
      'a'.repeat(3000),
      'b'.repeat(600),
      'c'.repeat(600),
    ])
  })

  test('handles large multi-chunk frames across buffer growth and compaction', () => {
    const payload = 'x'.repeat(80_000) + '🚀'
    const ndjsonReceived: string[] = []
    const ndjson = createNdjsonDecoder((msg) => ndjsonReceived.push(msg))
    const ndFrame = encodeNdjsonFrame(payload)

    for (let i = 0; i < ndFrame.byteLength; i += 64) {
      ndjson.push(ndFrame.subarray(i, Math.min(i + 64, ndFrame.byteLength)))
    }
    ndjson.flush()
    expect(ndjsonReceived).toEqual([payload])

    const clReceived: string[] = []
    const cl = createContentLengthDecoder((msg) => clReceived.push(msg))
    const clFrame = encodeContentLengthFrame(payload)

    for (let i = 0; i < clFrame.byteLength; i += 64) {
      cl.push(clFrame.subarray(i, Math.min(i + 64, clFrame.byteLength)))
    }
    cl.flush()
    expect(clReceived).toEqual([payload])
  })

  test('rejects invalid maxMessageSize values', () => {
    expect(() => createNdjsonDecoder(() => {}, 0)).toThrow(RangeError)
    expect(() => createNdjsonDecoder(() => {}, -5)).toThrow(RangeError)
    expect(() => createNdjsonDecoder(() => {}, Number.NaN)).toThrow(RangeError)
    expect(() => createContentLengthDecoder(() => {}, 1.5)).toThrow(RangeError)
  })
})

describe('streamTransport', () => {
  test('bidirectional ndjson messaging (default framing) and close propagation', async () => {
    const { a, b } = createConnectedPair()
    expect(isDuplexTransport(a)).toBe(true)

    const aReceived: string[] = []
    const bReceived: string[] = []
    let bClosed = 0

    const doneA = new Promise<void>((resolve) => {
      a.onMessage((msg) => {
        aReceived.push(msg)
        if (aReceived.length === 2) resolve()
      })
    })
    const doneB = new Promise<void>((resolve) => {
      b.onMessage((msg) => {
        bReceived.push(msg)
        void b.send(`reply:${msg}`)
        if (bReceived.length === 2) resolve()
      })
    })
    const bClosedPromise = new Promise<void>((resolve) => {
      b.onClose(() => {
        bClosed++
        resolve()
      })
    })

    await a.send('{"msg":"hello"}')
    await a.send('{"msg":"你好 🚀"}')

    await Promise.all([doneA, doneB])
    expect(bReceived).toEqual(['{"msg":"hello"}', '{"msg":"你好 🚀"}'])
    expect(aReceived).toEqual([
      'reply:{"msg":"hello"}',
      'reply:{"msg":"你好 🚀"}',
    ])

    await a.close()
    await a.close() // idempotent
    await bClosedPromise

    expect(bClosed).toBe(1)
    await expect(a.send('after-close')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
  })

  test('bidirectional content-length messaging with multi-byte UTF-8', async () => {
    const { a, b } = createConnectedPair('content-length')

    const received: string[] = []
    const allReceived = new Promise<void>((resolve) => {
      b.onMessage((msg) => {
        received.push(msg)
        if (received.length === 2) resolve()
      })
    })

    await a.send('{"greeting":"こんにちは 🌸"}')
    await a.send('{"emoji":"👨‍👩‍👧‍👦"}')
    await allReceived

    expect(received).toEqual(['{"greeting":"こんにちは 🌸"}', '{"emoji":"👨‍👩‍👧‍👦"}'])

    await a.close()
    await b.close()
  })

  test('closes transport with KrpcTransportError when inbound frame exceeds maxMessageSize', async () => {
    const source = createManualReadable()
    const sink = createSinkWritable()

    const transport = streamTransport({
      readable: source.readable,
      writable: sink.writable,
      framing: 'content-length',
      maxMessageSize: 10,
    })

    const received: string[] = []
    transport.onMessage((msg) => received.push(msg))

    const closeReason = await new Promise<unknown>((resolve) => {
      transport.onClose((reason) => resolve(reason))
      source.push(encodeContentLengthFrame('1234567890')) // ok (10 bytes)
      source.push(encodeContentLengthFrame('12345678901')) // exceeds 10 bytes
    })

    expect(received).toEqual(['1234567890'])
    expect(closeReason).toBeInstanceOf(KrpcTransportError)
    await expect(transport.send('after-error')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
  })

  test('handles chunked delivery and unsubscribe cleanly', async () => {
    const source = createManualReadable()
    const sink = createSinkWritable()

    const transport = streamTransport({
      readable: source.readable,
      writable: sink.writable,
      framing: 'content-length',
    })

    const received: string[] = []
    let off!: () => void
    const firstDone = new Promise<void>((resolve) => {
      off = transport.onMessage((msg) => {
        received.push(msg)
        if (received.length === 1) {
          off()
          resolve()
        }
      })
    })

    const frame1 = encodeContentLengthFrame('{"n":1,"emoji":"🌊"}')
    const frame2 = encodeContentLengthFrame('{"n":2}')

    // Split frame1 in the middle of the emoji UTF-8 bytes
    const mid = frame1.byteLength - 4
    source.push(frame1.subarray(0, mid))
    source.push(frame1.subarray(mid))
    await firstDone

    source.push(frame2)
    source.end()
    await new Promise<void>((resolve) => transport.onClose(() => resolve()))

    expect(received).toEqual(['{"n":1,"emoji":"🌊"}'])

    let lateNotified = false
    transport.onClose(() => {
      lateNotified = true
    })
    await Promise.resolve()
    expect(lateNotified).toBe(true)
  })

  test('wraps writable sink errors in KrpcTransportError', async () => {
    const source = createManualReadable()
    const failingWritable = new WritableStream<Uint8Array>({
      write() {
        throw new Error('disk full')
      },
    })
    const transport = streamTransport({
      readable: source.readable,
      writable: failingWritable,
    })

    await expect(transport.send('hello')).rejects.toBeInstanceOf(
      KrpcTransportError
    )
    await transport.close()
  })
})
