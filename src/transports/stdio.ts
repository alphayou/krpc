import { KrpcTransportError } from '../protocol/errors'
import {
  createContentLengthDecoder,
  createNdjsonDecoder,
  encodeContentLengthFrame,
  encodeNdjsonFrame,
  type StreamFraming,
} from './stream'
import type { DuplexTransport } from './types'

let textEncoder: TextEncoder | undefined

function getTextEncoder(): TextEncoder {
  return (textEncoder ??= new TextEncoder())
}

type StdioEventReadable = Exclude<StdioReadableLike, ReadableStream<Uint8Array>>

type StdioEventWritable = Exclude<StdioWritableLike, WritableStream<Uint8Array>>

interface GlobalWithProcess {
  readonly process?: {
    readonly stdin?: StdioReadableLike
    readonly stdout?: StdioWritableLike
  }
}

/**
 * Inbound byte stream accepted by `stdioTransport`.
 * Supports Web Standard `ReadableStream<Uint8Array>` and Node-style EventEmitter streams (such as `process.stdin`).
 */
export type StdioReadableLike =
  | ReadableStream<Uint8Array>
  | {
      /** Subscribe to `'data'`, `'end'`, `'error'`, or `'close'` events. */
      on(
        event: 'data' | 'end' | 'error' | 'close',
        listener: (...args: any[]) => void
      ): unknown
      /** Unsubscribe a previously registered listener (`EventEmitter.off`). */
      off?(
        event: 'data' | 'end' | 'error' | 'close',
        listener: (...args: any[]) => void
      ): unknown
      /** Unsubscribe a previously registered listener (`EventEmitter.removeListener`). */
      removeListener?(
        event: 'data' | 'end' | 'error' | 'close',
        listener: (...args: any[]) => void
      ): unknown
      /** Pause flowing mode so CLI processes exit cleanly when closed. */
      pause?(): unknown
      /** Resume flowing mode if the stream was previously paused. */
      resume?(): unknown
      /** Destroy the underlying readable stream when `closeStreams` is enabled. */
      destroy?(error?: Error): unknown
    }

/**
 * Outbound byte stream accepted by `stdioTransport`.
 * Supports Web Standard `WritableStream<Uint8Array>`, Node `Writable` streams (such as `process.stdout`), and Bun `FileSink` handles.
 */
export type StdioWritableLike =
  | WritableStream<Uint8Array>
  | {
      /** Write a UTF-8 byte chunk or string to the sink. */
      write(chunk: Uint8Array | string): unknown
      /** Close the sink when `closeStreams` is enabled. */
      end?(): unknown
      /** Flush any buffered bytes immediately (e.g. Bun `FileSink`). */
      flush?(): unknown
      /** Wait for backpressure relief when `write()` returns `false`. */
      once?(event: 'drain', listener: () => void): unknown
      /** Unsubscribe a pending `'drain'` listener (`EventEmitter.off`). */
      off?(event: 'drain', listener: () => void): unknown
      /** Unsubscribe a pending `'drain'` listener (`EventEmitter.removeListener`). */
      removeListener?(event: 'drain', listener: () => void): unknown
    }

/** Options for creating a `stdioTransport`. */
export interface StdioTransportOptions {
  /** Inbound stream supplying framed UTF-8 JSON-RPC messages (defaults to `process.stdin`). */
  readonly input?: StdioReadableLike
  /** Outbound stream receiving framed UTF-8 JSON-RPC messages (defaults to `process.stdout`). */
  readonly output?: StdioWritableLike
  /** Wire framing protocol (`"ndjson"` by default, or `"content-length"`). */
  readonly framing?: StreamFraming
  /** Maximum permitted inbound message body size in UTF-8 bytes (defaults to 16 MiB). */
  readonly maxMessageSize?: number
  /**
   * Whether `close()` cancels/destroys `input` and closes/ends `output`.
   * Defaults to `true` for explicitly provided streams and `false` when using global `process.stdin` / `process.stdout`.
   */
  readonly closeStreams?: boolean
}

function isReadableStream(
  value: StdioReadableLike
): value is ReadableStream<Uint8Array> {
  return typeof (value as ReadableStream<Uint8Array>).getReader === 'function'
}

function isWritableStream(
  value: StdioWritableLike
): value is WritableStream<Uint8Array> {
  return typeof (value as WritableStream<Uint8Array>).getWriter === 'function'
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function toUint8Array(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) {
    return chunk
  }
  if (typeof chunk === 'string') {
    return getTextEncoder().encode(chunk)
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk)
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return null
}

function removeEventListener<E extends string>(
  emitter: {
    off?(event: E, listener: (...args: any[]) => void): unknown
    removeListener?(event: E, listener: (...args: any[]) => void): unknown
  },
  event: E,
  listener: (...args: any[]) => void
): void {
  if (typeof emitter.off === 'function') {
    emitter.off(event, listener)
  } else if (typeof emitter.removeListener === 'function') {
    emitter.removeListener(event, listener)
  }
}

/**
 * Adapt standard I/O or subprocess pipes into a framed `DuplexTransport`.
 *
 * Defaults to `process.stdin` and `process.stdout` with `"ndjson"` framing, and
 * accepts both Web Standard streams (`ReadableStream` / `WritableStream`) and
 * Node / Bun stream handles (`process.stdin`, `process.stdout`, `Bun.spawn` pipes).
 */
export function stdioTransport(
  options?: StdioTransportOptions
): DuplexTransport {
  const proc = (globalThis as GlobalWithProcess).process
  const hasExplicitInput = options?.input !== undefined
  const hasExplicitOutput = options?.output !== undefined
  const input = options?.input ?? proc?.stdin
  const output = options?.output ?? proc?.stdout

  if (!input || !output) {
    throw new KrpcTransportError(
      'Stdio transport requires input and output streams (process.stdin and process.stdout are unavailable in this runtime)'
    )
  }

  const framing = options?.framing ?? 'ndjson'
  const shouldCloseInput = options?.closeStreams ?? hasExplicitInput
  const shouldCloseOutput = options?.closeStreams ?? hasExplicitOutput

  const encodeFrame =
    framing === 'content-length' ? encodeContentLengthFrame : encodeNdjsonFrame

  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()
  const drainCancelers = new Set<() => void>()

  let closed = false
  let closeReason: unknown
  let closePromise: Promise<void> | null = null

  const emitMessage = (message: string): void => {
    if (closed) {
      return
    }
    for (const handler of [...messageHandlers]) {
      try {
        handler(message)
      } catch {
        // Isolate listener exceptions from the stdio read loop.
      }
    }
  }

  const decoder =
    framing === 'content-length'
      ? createContentLengthDecoder(emitMessage, options?.maxMessageSize)
      : createNdjsonDecoder(emitMessage, options?.maxMessageSize)

  let reader: ReturnType<ReadableStream<Uint8Array>['getReader']> | null = null
  let eventInput: StdioEventReadable | null = null
  let writer: ReturnType<WritableStream<Uint8Array>['getWriter']> | null = null
  let sinkOutput: StdioEventWritable | null = null
  let writeQueue: Promise<void> = Promise.resolve()

  if (isWritableStream(output)) {
    writer = output.getWriter()
    writer.closed.catch(() => {})
  } else {
    sinkOutput = output
  }

  const waitForDrain = (sink: StdioEventWritable): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (closed) {
        reject(new KrpcTransportError('Stdio transport is closed'))
        return
      }
      const cleanup = (): void => {
        drainCancelers.delete(onAbort)
        removeEventListener(sink, 'drain', onDrain)
      }
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new KrpcTransportError('Stdio transport is closed'))
      }
      drainCancelers.add(onAbort)
      sink.once!('drain', onDrain)
    })

  let detachEventInput: (() => void) | null = null

  const closeTransport = (reason?: unknown): Promise<void> => {
    if (closePromise) {
      return closePromise
    }
    closed = true
    closeReason = reason
    detachEventInput?.()
    for (const cancel of [...drainCancelers]) {
      cancel()
    }
    const handlers = [...closeHandlers]
    closeHandlers.clear()
    messageHandlers.clear()

    closePromise = (async () => {
      if (reader) {
        if (shouldCloseInput) {
          try {
            await reader.cancel(reason)
          } catch {}
        }
        try {
          reader.releaseLock()
        } catch {}
      } else if (eventInput) {
        try {
          eventInput.pause?.()
        } catch {}
        if (shouldCloseInput) {
          try {
            eventInput.destroy?.()
          } catch {}
        }
      }

      if (writer) {
        if (shouldCloseOutput) {
          try {
            await writer.close()
          } catch {}
        }
        try {
          writer.releaseLock()
        } catch {}
      } else if (sinkOutput) {
        await writeQueue
        if (shouldCloseOutput) {
          try {
            await sinkOutput.end?.()
          } catch {}
        }
      }
    })()

    for (const handler of handlers) {
      try {
        handler(reason)
      } catch {
        // Isolate close listener exceptions from stdio cleanup.
      }
    }

    return closePromise
  }

  if (isReadableStream(input)) {
    const activeReader = input.getReader()
    reader = activeReader
    const readLoop = async (): Promise<void> => {
      let reason: unknown
      try {
        while (!closed) {
          const { done, value } = await activeReader.read()
          if (done) {
            if (!closed) {
              decoder.flush()
            }
            break
          }
          if (value && value.byteLength > 0) {
            decoder.push(value)
          }
        }
      } catch (err) {
        if (!closed) {
          reason = err
        }
      } finally {
        await closeTransport(reason)
      }
    }
    void readLoop()
  } else {
    eventInput = input
    const activeInput = input

    const onData = (chunk: unknown): void => {
      if (closed) {
        return
      }
      const bytes = toUint8Array(chunk)
      if (!bytes || bytes.byteLength === 0) {
        return
      }
      try {
        decoder.push(bytes)
      } catch (err) {
        if (!closed) {
          void closeTransport(err)
        }
      }
    }

    const onEnd = (): void => {
      if (closed) {
        return
      }
      let reason: unknown
      try {
        decoder.flush()
      } catch (err) {
        reason = err
      }
      void closeTransport(reason)
    }

    const onError = (err: unknown): void => {
      void closeTransport(err)
    }

    const onStreamClose = (): void => {
      void closeTransport()
    }

    detachEventInput = () => {
      removeEventListener(activeInput, 'data', onData)
      removeEventListener(activeInput, 'end', onEnd)
      removeEventListener(activeInput, 'error', onError)
      removeEventListener(activeInput, 'close', onStreamClose)
    }

    activeInput.on('data', onData)
    activeInput.on('end', onEnd)
    activeInput.on('error', onError)
    activeInput.on('close', onStreamClose)
    activeInput.resume?.()
  }

  return {
    send(message: string): Promise<void> {
      if (closed) {
        return Promise.reject(
          new KrpcTransportError('Stdio transport is closed')
        )
      }
      const frame = encodeFrame(message)

      if (writer) {
        const activeWriter = writer
        return activeWriter.write(frame).catch((cause) => {
          throw new KrpcTransportError('Failed to write to stdio transport', {
            cause,
          })
        })
      }

      const activeSink = sinkOutput!
      const run = writeQueue.then(async () => {
        if (closed) {
          throw new KrpcTransportError('Stdio transport is closed')
        }
        try {
          const written = activeSink.write(frame)
          if (written === false && typeof activeSink.once === 'function') {
            await waitForDrain(activeSink)
          } else if (isPromiseLike(written)) {
            await written
          }
          if (typeof activeSink.flush === 'function') {
            await activeSink.flush()
          }
        } catch (cause) {
          if (cause instanceof KrpcTransportError) {
            throw cause
          }
          throw new KrpcTransportError('Failed to write to stdio transport', {
            cause,
          })
        }
      })
      writeQueue = run.catch(() => {})
      return run
    },

    onMessage(handler: (message: string) => void): () => void {
      if (closed) {
        return () => {}
      }
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },

    onClose(handler: (reason?: unknown) => void): () => void {
      if (closed) {
        let active = true
        queueMicrotask(() => {
          if (active) {
            handler(closeReason)
          }
        })
        return () => {
          active = false
        }
      }
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },

    close(): Promise<void> {
      return closeTransport()
    },
  }
}
