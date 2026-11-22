import {
  KrpcTransportError,
  stringifyJsonRpcResponse,
} from '../protocol/errors'
import type { JsonRpcResponsePayload } from '../protocol/types'
import type { RpcServer } from '../server/server'
import type { RpcContext } from '../service/context'
import type { ClientTransport } from './types'

const DEFAULT_MAX_BODY_SIZE = 1024 * 1024
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

let textDecoder: TextDecoder | undefined

function getTextDecoder(): TextDecoder {
  return (textDecoder ??= new TextDecoder())
}

/** Supported header initializer accepted by the Web Fetch API. */
export type HttpHeadersInit = NonNullable<RequestInit['headers']>

/** Static or dynamic HTTP headers supplied with each `httpTransport` request. */
export type HttpHeadersInput =
  HttpHeadersInit | (() => HttpHeadersInit | Promise<HttpHeadersInit>)

/** Fetch credentials mode (`"same-origin"`, `"include"`, or `"omit"`). */
export type HttpCredentials = NonNullable<RequestInit['credentials']>

/** Web Standard `fetch` function signature accepted by `HttpTransportOptions.fetch`. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

/** Configuration options for `httpTransport`. */
export interface HttpTransportOptions {
  /** Static headers or a sync/async factory invoked on each request. */
  readonly headers?: HttpHeadersInput
  /** Custom Fetch API implementation (defaults to `globalThis.fetch`). */
  readonly fetch?: FetchLike
  /** Fetch credentials mode (`"same-origin"`, `"include"`, or `"omit"`). */
  readonly credentials?: HttpCredentials
}

/** Configuration options for `createHttpHandler`. */
export interface HttpHandlerOptions {
  /** Maximum permitted request body size in UTF-8 bytes (default: `1048576`, i.e. 1 MiB). */
  readonly maxBodySize?: number
  /** Populate request-scoped context tokens from the incoming HTTP `Request`. */
  readonly setupContext?: (
    ctx: RpcContext,
    req: Request
  ) => void | Promise<void>
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true
  }
  return error instanceof Error && error.name === 'AbortError'
}

function mergeRequestHeaders(input: HttpHeadersInit): [string, string][] {
  const headers = new Headers(input)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json')
  }
  const pairs: [string, string][] = []
  headers.forEach((value, key) => {
    pairs.push([key, value])
  })
  return pairs
}

function assertValidMaxBodySize(maxBodySize: number): void {
  if (
    Number.isNaN(maxBodySize) ||
    maxBodySize <= 0 ||
    (maxBodySize !== Number.POSITIVE_INFINITY && !Number.isInteger(maxBodySize))
  ) {
    throw new RangeError(
      `maxBodySize must be a positive integer or Infinity, received ${maxBodySize}`
    )
  }
}

function isJsonContentType(header: string | null): boolean {
  if (!header) {
    return false
  }
  const semicolon = header.indexOf(';')
  const mediaType = (semicolon === -1 ? header : header.slice(0, semicolon))
    .trim()
    .toLowerCase()
  return mediaType === 'application/json'
}

async function readBodyWithLimit(
  req: Request,
  maxBodySize: number
): Promise<string | null> {
  const body = req.body
  if (!body) {
    return ''
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value || value.byteLength === 0) {
        continue
      }
      totalBytes += value.byteLength
      if (totalBytes > maxBodySize) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }

  if (chunks.length === 0) {
    return ''
  }
  if (chunks.length === 1) {
    return getTextDecoder().decode(chunks[0])
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return getTextDecoder().decode(merged)
}

/**
 * Create a Fetch-based JSON-RPC 2.0 `ClientTransport` targeting an HTTP endpoint.
 *
 * Returns parsed JSON for `200` responses, `undefined` for `204` or empty bodies,
 * throws `KrpcTransportError` (with `status`) on non-2xx or invalid JSON responses,
 * and forwards `AbortSignal` directly to `fetch` without wrapping `AbortError`.
 */
export function httpTransport(
  url: string | URL,
  options?: HttpTransportOptions
): ClientTransport {
  const targetUrl = typeof url === 'string' ? url : url.toString()
  const fetchImpl = options?.fetch ?? globalThis.fetch
  const credentials = options?.credentials
  const headersOption = options?.headers

  const staticHeaders: [string, string][] | undefined =
    typeof headersOption === 'function'
      ? undefined
      : headersOption
        ? mergeRequestHeaders(headersOption)
        : [
            ['content-type', 'application/json'],
            ['accept', 'application/json'],
          ]

  return async (payload, sendOptions) => {
    const signal = sendOptions?.signal
    const headers =
      staticHeaders ??
      mergeRequestHeaders(
        await (
          headersOption as () => HttpHeadersInit | Promise<HttpHeadersInit>
        )()
      )

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }
    if (signal !== undefined) {
      init.signal = signal
    }
    if (credentials !== undefined) {
      init.credentials = credentials
    }

    let response: Response
    try {
      response = await fetchImpl(targetUrl, init)
    } catch (cause) {
      if (isAbortError(cause, signal)) {
        throw cause
      }
      throw new KrpcTransportError('HTTP transport request failed', { cause })
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new KrpcTransportError(
        `HTTP request failed with status ${response.status}`,
        { status: response.status }
      )
    }

    if (response.status === 204) {
      return undefined
    }

    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      if (isAbortError(cause, signal)) {
        throw cause
      }
      throw new KrpcTransportError('Failed to read HTTP response body', {
        status: response.status,
        cause,
      })
    }

    if (text.trim().length === 0) {
      return undefined
    }

    try {
      return JSON.parse(text) as JsonRpcResponsePayload
    } catch (cause) {
      throw new KrpcTransportError('Invalid JSON in HTTP response body', {
        status: response.status,
        cause,
      })
    }
  }
}

/**
 * Create a standard Web Fetch HTTP handler (`(req: Request) => Promise<Response>`)
 * backed by an `RpcServer`, ready for `Bun.serve`, Cloudflare Workers, Deno, or Hono.
 */
export function createHttpHandler(
  server: RpcServer<any>,
  options?: HttpHandlerOptions
): (req: Request) => Promise<Response> {
  const maxBodySize = options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE
  assertValidMaxBodySize(maxBodySize)
  const setupContext = options?.setupContext

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'POST' },
      })
    }

    if (!isJsonContentType(req.headers.get('content-type'))) {
      return new Response('Unsupported Media Type', { status: 415 })
    }

    const contentLengthHeader = req.headers.get('content-length')?.trim()
    if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
      const declaredLength = Number.parseInt(contentLengthHeader, 10)
      if (declaredLength > maxBodySize) {
        await req.body?.cancel().catch(() => {})
        return new Response('Payload Too Large', { status: 413 })
      }
    }

    const bodyText = await readBodyWithLimit(req, maxBodySize)
    if (bodyText === null) {
      return new Response('Payload Too Large', { status: 413 })
    }

    const responsePayload = await server.handleRaw(bodyText, {
      signal: req.signal,
      setupContext: setupContext ? (ctx) => setupContext(ctx, req) : undefined,
    })

    if (responsePayload === undefined) {
      return new Response(null, { status: 204 })
    }

    return new Response(stringifyJsonRpcResponse(responsePayload), {
      status: 200,
      headers: { 'content-type': JSON_CONTENT_TYPE },
    })
  }
}
