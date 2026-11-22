import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createPeer,
  defineMethod,
  defineNotify,
  defineService,
} from '../../src/index'
import { KrpcTransportError } from '../../src/protocol/errors'
import { stdioTransport, type StreamFraming } from '../../src/stdio'
import { isDuplexTransport } from '../../src/transports/types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class MockEventReadable {
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  paused = 0
  resumed = 0
  destroyed = 0

  on(
    event: 'data' | 'end' | 'error' | 'close',
    listener: (...args: any[]) => void
  ): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(
    event: 'data' | 'end' | 'error' | 'close',
    listener: (...args: any[]) => void
  ): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeListener(
    event: 'data' | 'end' | 'error' | 'close',
    listener: (...args: any[]) => void
  ): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  pause(): this {
    this.paused++
    return this
  }

  resume(): this {
    this.resumed++
    return this
  }

  destroy(): this {
    this.destroyed++
    return this
  }

  emit(event: 'data' | 'end' | 'error' | 'close', ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args)
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

class MockEventWritable {
  chunks: Uint8Array[] = []
  drainListeners = new Set<() => void>()
  backpressured = false
  asyncWrite = false
  failWith: Error | null = null
  flushed = 0
  ended = 0

  write(chunk: Uint8Array | string): boolean | Promise<number> {
    if (this.failWith) {
      throw this.failWith
    }
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    this.chunks.push(bytes)
    if (this.asyncWrite) {
      return Promise.resolve(bytes.byteLength)
    }
    return !this.backpressured
  }

  once(event: 'drain', listener: () => void): this {
    if (event === 'drain') {
      this.drainListeners.add(listener)
    }
    return this
  }

  off(event: 'drain', listener: () => void): this {
    if (event === 'drain') {
      this.drainListeners.delete(listener)
    }
    return this
  }

  flush(): Promise<void> {
    this.flushed++
    return Promise.resolve()
  }

  end(): Promise<void> {
    this.ended++
    return Promise.resolve()
  }

  emitDrain(): void {
    const list = [...this.drainListeners]
    this.drainListeners.clear()
    for (const listener of list) {
      listener()
    }
  }
}

describe('stdioTransport — Node-style EventEmitter streams', () => {
  test('receives Uint8Array, string, ArrayBuffer, and DataView chunks and isolates listener errors', async () => {
    const input = new MockEventReadable()
    const output = new MockEventWritable()
    const transport = stdioTransport({ input, output })

    expect(isDuplexTransport(transport)).toBe(true)
    expect(input.resumed).toBe(1)

    const received: string[] = []
    transport.onMessage(() => {
      throw new Error('listener boom')
    })
    const off = transport.onMessage((msg) => {
      received.push(msg)
    })

    // String chunk
    input.emit('data', '{"a":1}\n')
    // Uint8Array chunk with multi-byte UTF-8
    input.emit('data', encoder.encode('{"text":"café 🚀"}\n'))
    // ArrayBuffer chunk
    const abBytes = encoder.encode('{"b":2}\n')
    input.emit('data', abBytes.buffer.slice(0))
    // DataView (ArrayBufferView) chunk
    const dvBytes = encoder.encode('{"c":3}\n')
    input.emit(
      'data',
      new DataView(dvBytes.buffer, dvBytes.byteOffset, dvBytes.byteLength)
    )
    // Ignored empty and non-byte chunks
    input.emit('data', new Uint8Array(0))
    input.emit('data', 12345)

    expect(received).toEqual([
      '{"a":1}',
      '{"text":"café 🚀"}',
      '{"b":2}',
      '{"c":3}',
    ])

    off()
    input.emit('data', '{"ignored":true}\n')
    expect(received).toHaveLength(4)

    await transport.close()
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(input.listenerCount('close')).toBe(0)
    expect(input.paused).toBe(1)
    expect(input.destroyed).toBe(1)
    expect(output.ended).toBe(1)
  })

  test('supports removeListener fallback when off is absent', async () => {
    const base = new MockEventReadable()
    const input = {
      on: base.on.bind(base),
      removeListener: base.removeListener.bind(base),
      pause: base.pause.bind(base),
    }
    const output = new MockEventWritable()
    const transport = stdioTransport({ input, output })

    await transport.close()
    expect(base.listenerCount('data')).toBe(0)
    expect(base.listenerCount('end')).toBe(0)
    expect(base.listenerCount('error')).toBe(0)
    expect(base.listenerCount('close')).toBe(0)
    expect(base.paused).toBe(1)
  })

  test('handles backpressure via drain, serializes writes, calls flush, and rejects drain on close', async () => {
    const input = new MockEventReadable()
    const output = new MockEventWritable()
    output.backpressured = true

    const transport = stdioTransport({ input, output })

    let firstDone = false
    let secondDone = false
    const p1 = Promise.resolve(transport.send('{"id":1}')).then(() => {
      firstDone = true
    })
    const p2 = Promise.resolve(transport.send('{"id":2}')).then(() => {
      secondDone = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(output.chunks).toHaveLength(1)
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)
    expect(output.drainListeners.size).toBe(1)

    // Release first drain -> first finishes and flushes, second writes and waits for drain
    output.emitDrain()
    await p1
    expect(firstDone).toBe(true)
    expect(output.flushed).toBe(1)
    expect(output.chunks).toHaveLength(2)
    expect(secondDone).toBe(false)

    // Release second drain
    output.backpressured = false
    output.emitDrain()
    await p2
    expect(secondDone).toBe(true)
    expect(output.flushed).toBe(2)
    expect(output.chunks.map((c) => decoder.decode(c))).toEqual([
      '{"id":1}\n',
      '{"id":2}\n',
    ])

    // Closing while waiting for drain rejects pending send and cleans up drain listener
    output.backpressured = true
    const p3 = transport.send('{"id":3}')
    await Promise.resolve()
    await Promise.resolve()
    expect(output.drainListeners.size).toBe(1)

    const closeDone = transport.close()
    await expect(p3).rejects.toThrow(KrpcTransportError)
    await closeDone
    expect(output.drainListeners.size).toBe(0)
  })

  test('supports async write sinks and wraps write failures in KrpcTransportError', async () => {
    const input = new MockEventReadable()
    const output = new MockEventWritable()
    output.asyncWrite = true

    const transport = stdioTransport({ input, output })
    await transport.send('{"ok":true}')
    expect(output.flushed).toBe(1)

    const boom = new Error('broken pipe')
    output.failWith = boom
    await expect(transport.send('{"fail":true}')).rejects.toThrow(
      KrpcTransportError
    )

    await transport.close()
    await expect(transport.send('{"afterClose":true}')).rejects.toThrow(
      KrpcTransportError
    )
  })

  test('propagates error, end (flush), and close events cleanly with listener isolation', async () => {
    // 1. Error event
    const input1 = new MockEventReadable()
    const output1 = new MockEventWritable()
    const t1 = stdioTransport({ input: input1, output: output1 })
    const reasons1: unknown[] = []
    t1.onClose(() => {
      throw new Error('close handler boom')
    })
    t1.onClose((r) => reasons1.push(r))

    const err = new Error('stdin read failure')
    input1.emit('error', err)
    expect(reasons1).toEqual([err])
    // Late onClose registration fires on microtask with stored reason
    let lateReason: unknown
    t1.onClose((r) => {
      lateReason = r
    })
    let cancelledCalled = false
    const unsubLate = t1.onClose(() => {
      cancelledCalled = true
    })
    unsubLate()
    await Promise.resolve()
    expect(lateReason).toBe(err)
    expect(cancelledCalled).toBe(false)
    // onMessage after close is a no-op
    expect(typeof t1.onMessage(() => {})).toBe('function')

    // 2. End event flushes trailing NDJSON message
    const input2 = new MockEventReadable()
    const output2 = new MockEventWritable()
    const t2 = stdioTransport({ input: input2, output: output2 })
    const msgs2: string[] = []
    t2.onMessage((m) => msgs2.push(m))
    let closed2 = false
    t2.onClose(() => {
      closed2 = true
    })

    input2.emit('data', '{"trailing":true}')
    input2.emit('end')
    expect(msgs2).toEqual(['{"trailing":true}'])
    expect(closed2).toBe(true)

    // 3. End event with truncated Content-Length frame reports error reason
    const input3 = new MockEventReadable()
    const output3 = new MockEventWritable()
    const t3 = stdioTransport({
      input: input3,
      output: output3,
      framing: 'content-length',
    })
    let reason3: unknown
    t3.onClose((r) => {
      reason3 = r
    })
    input3.emit('data', 'Content-Length: 50\r\n\r\n{"partial":')
    input3.emit('end')
    expect(reason3).toBeInstanceOf(KrpcTransportError)

    // 4. Close event without end
    const input4 = new MockEventReadable()
    const output4 = new MockEventWritable()
    const t4 = stdioTransport({ input: input4, output: output4 })
    let closed4 = false
    t4.onClose(() => {
      closed4 = true
    })
    input4.emit('close')
    expect(closed4).toBe(true)

    // 5. Re-entrant close() inside onClose is strictly idempotent (cleanup runs once)
    const input5 = new MockEventReadable()
    const output5 = new MockEventWritable()
    const t5 = stdioTransport({ input: input5, output: output5 })
    let reentrantClose: unknown
    t5.onClose(() => {
      reentrantClose = t5.close()
    })
    const firstClose = t5.close()
    expect(reentrantClose).toBe(firstClose)
    await firstClose
    expect(input5.paused).toBe(1)
    expect(input5.destroyed).toBe(1)
    expect(output5.ended).toBe(1)

    // 6. maxMessageSize exceeded on EventEmitter data closes transport with KrpcTransportError
    const input6 = new MockEventReadable()
    const output6 = new MockEventWritable()
    const t6 = stdioTransport({
      input: input6,
      output: output6,
      maxMessageSize: 8,
    })
    let reason6: unknown
    t6.onClose((r) => {
      reason6 = r
    })
    input6.emit('data', '{"oversized":true}\n')
    expect(reason6).toBeInstanceOf(KrpcTransportError)
    await t6.close()
    expect(input6.paused).toBe(1)
    expect(input6.destroyed).toBe(1)
    expect(output6.ended).toBe(1)
  })

  test('respects closeStreams: false and never destroys/ends default global process.stdin/stdout', async () => {
    // Explicit closeStreams: false
    const explicitIn = new MockEventReadable()
    const explicitOut = new MockEventWritable()
    const explicitTransport = stdioTransport({
      input: explicitIn,
      output: explicitOut,
      closeStreams: false,
    })
    await explicitTransport.close()
    expect(explicitIn.paused).toBe(1)
    expect(explicitIn.destroyed).toBe(0)
    expect(explicitOut.ended).toBe(0)

    // Default process.stdin / process.stdout via globalThis
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')
    const fakeStdin = new MockEventReadable()
    const fakeStdout = new MockEventWritable()
    try {
      Object.defineProperty(globalThis, 'process', {
        value: { stdin: fakeStdin, stdout: fakeStdout },
        configurable: true,
        writable: true,
      })

      const defaultTransport = stdioTransport()
      await defaultTransport.send('{"default":true}')
      expect(decoder.decode(fakeStdout.chunks[0])).toBe('{"default":true}\n')

      await defaultTransport.close()
      expect(fakeStdin.listenerCount('data')).toBe(0)
      expect(fakeStdin.paused).toBe(1)
      expect(fakeStdin.destroyed).toBe(0)
      expect(fakeStdout.ended).toBe(0)

      // Missing global process throws clear KrpcTransportError
      Object.defineProperty(globalThis, 'process', {
        value: undefined,
        configurable: true,
        writable: true,
      })
      expect(() => stdioTransport()).toThrow(KrpcTransportError)
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor)
      }
    }
  })
})

describe('stdioTransport — Web ReadableStream / WritableStream', () => {
  test('supports both ndjson and content-length framing with createPeer', async () => {
    const app = defineService(() => ({
      echo: defineMethod(({ text }: { text: string }) => text),
      add: defineMethod(([a, b]: [number, number]) => a + b),
    }))

    for (const framing of ['ndjson', 'content-length'] as const) {
      const aToB = new TransformStream<Uint8Array, Uint8Array>()
      const bToA = new TransformStream<Uint8Array, Uint8Array>()

      const serverPeer = createPeer(
        stdioTransport({
          input: aToB.readable,
          output: bToA.writable,
          framing,
        }),
        app
      )
      const clientPeer = createPeer<typeof app>(
        stdioTransport({
          input: bToA.readable,
          output: aToB.writable,
          framing,
        })
      )

      expect(await clientPeer.call('echo', { text: 'café 🚀' })).toEqual({
        ok: true,
        value: 'café 🚀',
      })
      expect(await clientPeer.call('add', [20, 22])).toEqual({
        ok: true,
        value: 42,
      })

      await clientPeer.close()
      await serverPeer.close()
    }
  })

  test('enforces maxMessageSize and respects closeStreams: false on Web streams', async () => {
    const aToB = new TransformStream<Uint8Array, Uint8Array>()
    const bToA = new TransformStream<Uint8Array, Uint8Array>()

    expect(() =>
      stdioTransport({
        input: aToB.readable,
        output: bToA.writable,
        maxMessageSize: 0,
      })
    ).toThrow(RangeError)

    let writableClosed = false
    const chunks: Uint8Array[] = []
    let readableCtrl!: ReadableStreamDefaultController<Uint8Array>
    const input = new ReadableStream<Uint8Array>({
      start(ctrl) {
        readableCtrl = ctrl
      },
    })
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      },
      close() {
        writableClosed = true
      },
    })

    const transport = stdioTransport({
      input,
      output,
      maxMessageSize: 8,
      closeStreams: false,
    })

    const closed = new Promise<unknown>((resolve) => {
      transport.onClose((reason) => resolve(reason))
    })

    await transport.send('{"a":1}')
    expect(decoder.decode(chunks[0])).toBe('{"a":1}\n')

    // Exceed maxMessageSize -> closes transport with KrpcTransportError without closing output stream
    readableCtrl.enqueue(encoder.encode('{"oversized":true}\n'))
    const reason = await closed
    expect(reason).toBeInstanceOf(KrpcTransportError)
    await transport.close()
    expect(writableClosed).toBe(false)
    readableCtrl.close()
  })

  test('wraps Web WritableStream write failures in KrpcTransportError', async () => {
    const input = new ReadableStream<Uint8Array>({
      start() {},
    })
    const output = new WritableStream<Uint8Array>({
      write() {
        throw new Error('writable failed')
      },
    })

    const transport = stdioTransport({ input, output })
    await expect(transport.send('{"a":1}')).rejects.toThrow(KrpcTransportError)
    await transport.close()
  })
})

describe('stdioTransport — real OS child-process integration via Bun.spawn', () => {
  const indexUrl = pathToFileURL(
    resolve(import.meta.dir, '../../src/index.ts')
  ).href
  const stdioUrl = pathToFileURL(
    resolve(import.meta.dir, '../../src/stdio.ts')
  ).href

  const workerCode = `
    import { createPeer, defineMethod, defineNotify, defineService } from ${JSON.stringify(indexUrl)}
    import { stdioTransport } from ${JSON.stringify(stdioUrl)}

    const framing = process.argv[1] === 'content-length' ? 'content-length' : 'ndjson'
    const events = []
    const progress = defineNotify()
    const afterEvent = defineNotify()

    const app = defineService(() => ({
      progress,
      afterEvent,
      add: defineMethod(([a, b]) => a + b),
      echo: defineMethod(({ text }) => text),
      noop: defineMethod(() => {}),
      record: defineMethod(({ tag }) => {
        events.push(tag)
      }),
      getEvents: defineMethod(() => events),
      runJob: defineMethod(async ({ id }, ctx) => {
        await ctx.notify(progress, { id, step: 1 })
        ctx.after(async () => {
          await ctx.notify(afterEvent, { id, done: true })
        })
        return { accepted: id }
      }),
    }))

    createPeer(stdioTransport({ framing }), app)
  `

  for (const framing of ['ndjson', 'content-length'] as StreamFraming[]) {
    test(`communicates with a real child process over stdin/stdout pipes (${framing}) and exits 0 cleanly`, async () => {
      const progress = defineNotify<{ id: string; step: number }>()
      const afterEvent = defineNotify<{ id: string; done: boolean }>()

      const appShape = defineService(() => ({
        progress,
        afterEvent,
        add: defineMethod(([a, b]: [number, number]) => a + b),
        echo: defineMethod(({ text }: { text: string }) => text),
        noop: defineMethod(() => {}),
        record: defineMethod((_params: { tag: string }) => {}),
        getEvents: defineMethod((): string[] => []),
        runJob: defineMethod((_params: { id: string }) => ({ accepted: '' })),
      }))

      const proc = Bun.spawn([process.execPath, '-e', workerCode, framing], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const peer = createPeer<typeof appShape>(
        stdioTransport({
          input: proc.stdout,
          output: proc.stdin,
          framing,
        })
      )

      const progressEvents: Array<{ id: string; step: number }> = []
      let resolveAfter!: (payload: { id: string; done: boolean }) => void
      const afterReceived = new Promise<{ id: string; done: boolean }>(
        (resolve) => {
          resolveAfter = resolve
        }
      )

      peer.on('progress', (payload) => {
        progressEvents.push(payload)
      })
      peer.on('afterEvent', (payload) => {
        resolveAfter(payload)
      })

      // 1. Typed RPC calls including multi-byte UTF-8 and void -> null
      expect(await peer.call('add', [19, 23])).toEqual({ ok: true, value: 42 })
      expect(await peer.call('echo', { text: 'café 🚀' })).toEqual({
        ok: true,
        value: 'café 🚀',
      })
      expect(await peer.call('noop')).toEqual({ ok: true, value: null })

      // 2. Client -> server fire-and-forget notification
      await peer.notify('record', { tag: `notify-${framing}` })
      expect(await peer.call('getEvents')).toEqual({
        ok: true,
        value: [`notify-${framing}`],
      })

      // 3. Server -> client push notifications via ctx.notify and ctx.after
      expect(await peer.call('runJob', { id: 'job-1' })).toEqual({
        ok: true,
        value: { accepted: 'job-1' },
      })
      expect(progressEvents).toEqual([{ id: 'job-1', step: 1 }])
      expect(await afterReceived).toEqual({ id: 'job-1', done: true })

      // 4. Clean shutdown: closing parent transport sends EOF to child stdin, child exits 0
      await peer.close()
      const exitCode = await proc.exited
      const stderrText = await new Response(proc.stderr).text()

      expect(stderrText).toBe('')
      expect(exitCode).toBe(0)
    })
  }
})
