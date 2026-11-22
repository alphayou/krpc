import { KrpcTransportError } from '../protocol/errors'
import type { DuplexTransport } from './types'

const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 * 1024
const MAX_HEADER_SIZE = 8 * 1024
const INITIAL_BUFFER_CAPACITY = 4096
const MAX_RETAINED_BUFFER_CAPACITY = 64 * 1024
const CR = 0x0d
const LF = 0x0a

let textEncoder: TextEncoder | undefined
let textDecoder: TextDecoder | undefined
let emptyBytes: Uint8Array | undefined

function getTextEncoder(): TextEncoder {
  return (textEncoder ??= new TextEncoder())
}

function getTextDecoder(): TextDecoder {
  return (textDecoder ??= new TextDecoder())
}

function getEmptyBytes(): Uint8Array {
  return (emptyBytes ??= new Uint8Array(0))
}

/** Supported wire framing formats for `streamTransport`. */
export type StreamFraming = 'ndjson' | 'content-length'

/** Options for creating a `streamTransport`. */
export interface StreamTransportOptions {
  /** Inbound byte stream supplying framed UTF-8 JSON-RPC messages. */
  readonly readable: ReadableStream<Uint8Array>
  /** Outbound byte stream receiving framed UTF-8 JSON-RPC messages. */
  readonly writable: WritableStream<Uint8Array>
  /** Wire framing protocol (`"ndjson"` by default, or `"content-length"`). */
  readonly framing?: StreamFraming
  /** Maximum permitted inbound message body size in UTF-8 bytes (defaults to 16 MiB). */
  readonly maxMessageSize?: number
}

/** Incremental byte-stream frame decoder. */
export interface FrameDecoder {
  /** Feed the next raw byte chunk into the decoder, invoking the message callback for each complete frame. */
  push(chunk: Uint8Array): void
  /** Signal end-of-stream to emit any trailing complete message or reject truncated frames. */
  flush(): void
}

/**
 * Amortized O(n) contiguous byte queue with offset cursors and geometric growth.
 * Reuses its slab across frames and releases oversized slabs once drained.
 */
class ByteQueue {
  data: Uint8Array = getEmptyBytes()
  readOffset = 0
  writeOffset = 0

  get length(): number {
    return this.writeOffset - this.readOffset
  }

  append(chunk: Uint8Array): void {
    const chunkLen = chunk.byteLength
    if (chunkLen === 0) {
      return
    }

    const remaining = this.writeOffset - this.readOffset
    const needed = remaining + chunkLen

    if (this.writeOffset + chunkLen <= this.data.byteLength) {
      this.data.set(chunk, this.writeOffset)
      this.writeOffset += chunkLen
      return
    }

    if (
      this.readOffset >= this.data.byteLength >>> 1 &&
      needed <= this.data.byteLength
    ) {
      if (remaining > 0) {
        this.data.copyWithin(0, this.readOffset, this.writeOffset)
      }
      this.readOffset = 0
      this.writeOffset = remaining
      this.data.set(chunk, this.writeOffset)
      this.writeOffset += chunkLen
      return
    }

    const nextCapacity = Math.max(
      needed,
      this.data.byteLength * 2,
      INITIAL_BUFFER_CAPACITY
    )
    const next = new Uint8Array(nextCapacity)
    if (remaining > 0) {
      next.set(this.data.subarray(this.readOffset, this.writeOffset), 0)
    }
    next.set(chunk, remaining)
    this.data = next
    this.readOffset = 0
    this.writeOffset = needed
  }

  consume(count: number): void {
    this.readOffset += count
    if (this.readOffset >= this.writeOffset) {
      this.readOffset = 0
      this.writeOffset = 0
      if (this.data.byteLength > MAX_RETAINED_BUFFER_CAPACITY) {
        this.data = getEmptyBytes()
      }
    }
  }

  clear(): void {
    this.readOffset = 0
    this.writeOffset = 0
    if (this.data.byteLength > MAX_RETAINED_BUFFER_CAPACITY) {
      this.data = getEmptyBytes()
    }
  }
}

function assertValidMaxMessageSize(maxMessageSize: number): void {
  if (
    Number.isNaN(maxMessageSize) ||
    maxMessageSize <= 0 ||
    (maxMessageSize !== Number.POSITIVE_INFINITY &&
      !Number.isInteger(maxMessageSize))
  ) {
    throw new RangeError(
      `maxMessageSize must be a positive integer or Infinity, received ${maxMessageSize}`
    )
  }
}

function findHeaderEnd(bytes: Uint8Array, start: number, end: number): number {
  const limit = end - 4
  let i = start
  while (i <= limit) {
    i = bytes.indexOf(CR, i)
    if (i === -1 || i > limit) {
      return -1
    }
    if (bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) {
      return i
    }
    i++
  }
  return -1
}

function parseContentLengthHeader(headerText: string): number {
  let contentLength: number | null = null
  const lines = headerText.split('\r\n')

  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) {
      throw new KrpcTransportError(`Malformed frame header line: "${line}"`)
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    if (name.length === 0) {
      throw new KrpcTransportError(`Malformed frame header line: "${line}"`)
    }
    const value = line.slice(colon + 1).trim()
    if (name === 'content-length') {
      if (!/^\d+$/.test(value)) {
        throw new KrpcTransportError(`Invalid Content-Length value: "${value}"`)
      }
      const parsed = Number.parseInt(value, 10)
      if (!Number.isSafeInteger(parsed)) {
        throw new KrpcTransportError(
          `Content-Length exceeds safe integer range: "${value}"`
        )
      }
      if (contentLength !== null && contentLength !== parsed) {
        throw new KrpcTransportError('Conflicting Content-Length headers')
      }
      contentLength = parsed
    }
  }

  if (contentLength === null) {
    throw new KrpcTransportError('Missing Content-Length header')
  }
  return contentLength
}

/** Encode a single UTF-8 message as a newline-delimited JSON frame (`<message>\n`). */
export function encodeNdjsonFrame(message: string): Uint8Array {
  return getTextEncoder().encode(`${message}\n`)
}

/** Encode a single UTF-8 message with an LSP/MCP `Content-Length` byte-count header. */
export function encodeContentLengthFrame(message: string): Uint8Array {
  const body = getTextEncoder().encode(message)
  const header = `Content-Length: ${body.byteLength}\r\n\r\n`
  const headerLen = header.length
  const frame = new Uint8Array(headerLen + body.byteLength)
  for (let i = 0; i < headerLen; i++) {
    frame[i] = header.charCodeAt(i)
  }
  frame.set(body, headerLen)
  return frame
}

/** Create an incremental decoder for `\n`-delimited UTF-8 frames (supporting `\r\n`). */
export function createNdjsonDecoder(
  onMessage: (message: string) => void,
  maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE
): FrameDecoder {
  assertValidMaxMessageSize(maxMessageSize)
  const queue = new ByteQueue()
  let scannedLength = 0

  return {
    push(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) {
        return
      }
      queue.append(chunk)

      while (queue.length > scannedLength) {
        const searchFrom = queue.readOffset + scannedLength
        const newlineIndex = queue.data.indexOf(LF, searchFrom)
        if (newlineIndex === -1 || newlineIndex >= queue.writeOffset) {
          scannedLength = queue.length
          break
        }

        let lineEnd = newlineIndex
        if (lineEnd > queue.readOffset && queue.data[lineEnd - 1] === CR) {
          lineEnd--
        }

        const lineLength = lineEnd - queue.readOffset
        if (lineLength > maxMessageSize) {
          queue.clear()
          scannedLength = 0
          throw new KrpcTransportError(
            `Message size ${lineLength} exceeds maximum allowed size of ${maxMessageSize} bytes`
          )
        }

        const message =
          lineLength > 0
            ? getTextDecoder().decode(
                queue.data.subarray(queue.readOffset, lineEnd)
              )
            : null

        queue.consume(newlineIndex - queue.readOffset + 1)
        scannedLength = 0

        if (message !== null) {
          onMessage(message)
        }
      }

      if (queue.length > 0) {
        const pendingLength =
          queue.data[queue.writeOffset - 1] === CR
            ? queue.length - 1
            : queue.length
        if (pendingLength > maxMessageSize) {
          queue.clear()
          scannedLength = 0
          throw new KrpcTransportError(
            `Message size ${pendingLength} exceeds maximum allowed size of ${maxMessageSize} bytes`
          )
        }
      }
    },

    flush(): void {
      if (queue.length === 0) {
        return
      }
      let lineEnd = queue.writeOffset
      if (queue.data[lineEnd - 1] === CR) {
        lineEnd--
      }
      const lineLength = lineEnd - queue.readOffset
      if (lineLength > maxMessageSize) {
        queue.clear()
        scannedLength = 0
        throw new KrpcTransportError(
          `Message size ${lineLength} exceeds maximum allowed size of ${maxMessageSize} bytes`
        )
      }
      const message =
        lineLength > 0
          ? getTextDecoder().decode(
              queue.data.subarray(queue.readOffset, lineEnd)
            )
          : null
      queue.clear()
      scannedLength = 0
      if (message !== null) {
        onMessage(message)
      }
    },
  }
}

/**
 * Create an incremental decoder for `Content-Length: <byteLen>\r\n\r\n<utf8>` frames.
 * Counts exact UTF-8 bytes and handles arbitrary chunk splits and sticky packets.
 */
export function createContentLengthDecoder(
  onMessage: (message: string) => void,
  maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE
): FrameDecoder {
  assertValidMaxMessageSize(maxMessageSize)
  const queue = new ByteQueue()
  let expectedBodyLength: number | null = null
  let scannedHeaderLength = 0

  return {
    push(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) {
        return
      }
      queue.append(chunk)

      while (true) {
        if (expectedBodyLength === null) {
          const searchStart =
            queue.readOffset + Math.max(0, scannedHeaderLength - 3)
          const headerEnd = findHeaderEnd(
            queue.data,
            searchStart,
            queue.writeOffset
          )
          if (headerEnd === -1) {
            if (queue.length > MAX_HEADER_SIZE) {
              queue.clear()
              scannedHeaderLength = 0
              throw new KrpcTransportError(
                `Frame header exceeds maximum size of ${MAX_HEADER_SIZE} bytes`
              )
            }
            scannedHeaderLength = queue.length
            break
          }

          const headerLength = headerEnd - queue.readOffset
          if (headerLength > MAX_HEADER_SIZE) {
            queue.clear()
            scannedHeaderLength = 0
            throw new KrpcTransportError(
              `Frame header exceeds maximum size of ${MAX_HEADER_SIZE} bytes`
            )
          }

          const headerText = getTextDecoder().decode(
            queue.data.subarray(queue.readOffset, headerEnd)
          )
          let length: number
          try {
            length = parseContentLengthHeader(headerText)
          } catch (err) {
            queue.clear()
            scannedHeaderLength = 0
            throw err
          }
          if (length > maxMessageSize) {
            queue.clear()
            scannedHeaderLength = 0
            throw new KrpcTransportError(
              `Message size ${length} exceeds maximum allowed size of ${maxMessageSize} bytes`
            )
          }

          queue.consume(headerEnd - queue.readOffset + 4)
          scannedHeaderLength = 0
          expectedBodyLength = length
        }

        if (queue.length < expectedBodyLength) {
          break
        }

        const body = getTextDecoder().decode(
          queue.data.subarray(
            queue.readOffset,
            queue.readOffset + expectedBodyLength
          )
        )
        queue.consume(expectedBodyLength)
        expectedBodyLength = null

        onMessage(body)
      }
    },

    flush(): void {
      const hasIncompleteFrame = expectedBodyLength !== null || queue.length > 0
      queue.clear()
      expectedBodyLength = null
      scannedHeaderLength = 0
      if (hasIncompleteFrame) {
        throw new KrpcTransportError(
          'Unexpected end of stream while reading Content-Length frame'
        )
      }
    },
  }
}

/**
 * Adapt Web Standard `ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>`
 * into a framed `DuplexTransport`.
 */
export function streamTransport(
  options: StreamTransportOptions
): DuplexTransport {
  const framing = options.framing ?? 'ndjson'
  const maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE
  assertValidMaxMessageSize(maxMessageSize)

  const encodeFrame =
    framing === 'content-length' ? encodeContentLengthFrame : encodeNdjsonFrame

  const messageHandlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(reason?: unknown) => void>()

  let closed = false
  let closeReason: unknown
  let closePromise: Promise<void> | null = null

  const emitMessage = (message: string): void => {
    if (closed) {
      return
    }
    for (const handler of messageHandlers) {
      handler(message)
    }
  }

  const emitClose = (reason?: unknown): void => {
    if (closed) {
      return
    }
    closed = true
    closeReason = reason
    const handlers = [...closeHandlers]
    closeHandlers.clear()
    messageHandlers.clear()
    for (const handler of handlers) {
      handler(reason)
    }
  }

  const decoder =
    framing === 'content-length'
      ? createContentLengthDecoder(emitMessage, maxMessageSize)
      : createNdjsonDecoder(emitMessage, maxMessageSize)

  const reader = options.readable.getReader()
  const writer = options.writable.getWriter()

  writer.closed.catch(() => {})

  const closeStreams = async (reason?: unknown): Promise<void> => {
    if (closePromise) {
      return closePromise
    }
    emitClose(reason)
    closePromise = (async () => {
      try {
        await reader.cancel(reason)
      } catch {
      } finally {
        try {
          reader.releaseLock()
        } catch {}
      }
      try {
        await writer.close()
      } catch {
      } finally {
        try {
          writer.releaseLock()
        } catch {}
      }
    })()
    return closePromise
  }

  const readLoop = async (): Promise<void> => {
    let reason: unknown
    try {
      while (!closed) {
        const { done, value } = await reader.read()
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
      await closeStreams(reason)
    }
  }

  void readLoop()

  return {
    async send(message: string): Promise<void> {
      if (closed) {
        throw new KrpcTransportError('Stream transport is closed')
      }
      const frame = encodeFrame(message)
      try {
        await writer.write(frame)
      } catch (cause) {
        throw new KrpcTransportError('Failed to write to stream transport', {
          cause,
        })
      }
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
      return closeStreams()
    },
  }
}
