import type { RpcServer, ServerConnection } from '../server/server'
import type { RpcContext } from '../service/context'
import type { ServiceTree } from '../service/service'
import { createHttpHandler } from './http'
import { createWsHandler, type ServerWebSocketLike, type WsHandler } from './ws'

/** Upgrade metadata stored on `ws.data` by `createBunHandler`. */
export interface BunWebSocketData {
  /** Resolved client identifier passed to `server.connect`, or `undefined` to auto-generate. */
  readonly id: string | undefined
  /** Original HTTP upgrade `Request` used to populate context and lifecycle hooks. */
  readonly req: Request
}

/** Minimal structural shape of a `Bun.Server` instance passed to `fetch(req, srv)`. */
export interface BunServerLike {
  /** Upgrade an incoming HTTP `Request` to a server-side WebSocket connection. */
  upgrade(req: Request, options?: { data?: any }): boolean
}

/** Minimal structural shape of a Bun `ServerWebSocket` carrying upgrade `data`. */
export interface BunWebSocketLike<
  T = BunWebSocketData,
> extends ServerWebSocketLike {
  /** Contextual data attached during `server.upgrade(req, { data })`. */
  readonly data: T
}

/** Configuration options for `createBunHandler`. */
export interface BunHandlerOptions<S extends ServiceTree = ServiceTree> {
  /** Optional pathname filter (e.g. `"/rpc"`); non-matching requests receive `404 Not Found`. */
  readonly path?: string
  /** Derive a connection ID for WebSocket upgrades, exposed on `ctx.clientId` and targeted by `server.notify`. */
  readonly id?: (
    req: Request
  ) => string | undefined | Promise<string | undefined>
  /** Populate request-scoped context tokens from the HTTP `Request` (shared across HTTP and WebSocket calls). */
  readonly setupContext?: (
    ctx: RpcContext,
    req: Request
  ) => void | Promise<void>
  /** Maximum permitted HTTP request body size in UTF-8 bytes (default: `1048576`, i.e. 1 MiB). */
  readonly maxBodySize?: number
  /** Keep background HTTP `ctx.after(...)` tasks alive after the `Response` is returned. */
  readonly waitUntil?: (promise: Promise<void>) => void
  /** Invoked after a WebSocket connection opens and is registered on the `RpcServer`. */
  readonly onOpen?: (conn: ServerConnection<S>, req: Request) => void
  /** Invoked once when a WebSocket connection closes (either by the peer or via `conn.close()`). */
  readonly onClose?: (
    conn: ServerConnection<S>,
    req: Request,
    reason?: unknown
  ) => void
}

/** Unified HTTP + WebSocket handler returned by `createBunHandler` for `Bun.serve`. */
export interface BunHandler {
  /** Handle an incoming HTTP RPC request or upgrade a WebSocket handshake on the same endpoint. */
  fetch(req: Request, srv: BunServerLike): Promise<Response | undefined>
  /** WebSocket lifecycle callbacks compatible with `Bun.serve({ websocket })`. */
  readonly websocket: WsHandler<BunWebSocketLike<BunWebSocketData>> & {
    /** Type marker allowing `Bun.serve` to infer `ServerWebSocket<BunWebSocketData>`. */
    readonly data?: BunWebSocketData
  }
}

/**
 * Create a unified HTTP + WebSocket handler (`{ fetch, websocket }`) for `Bun.serve`
 * backed by a single `RpcServer`.
 *
 * Works with `export default createBunHandler(server)`,
 * `Bun.serve({ port: 3000, ...createBunHandler(server) })`, and custom `fetch` composition.
 */
export function createBunHandler<S extends ServiceTree>(
  server: RpcServer<S>,
  options?: BunHandlerOptions<S>
): BunHandler {
  const path = options?.path
  const resolveId = options?.id
  const setupContext = options?.setupContext
  const onOpen = options?.onOpen
  const onClose = options?.onClose

  const httpHandler = createHttpHandler(server, {
    maxBodySize: options?.maxBodySize,
    waitUntil: options?.waitUntil,
    setupContext,
  })

  const websocket = createWsHandler<S, BunWebSocketLike<BunWebSocketData>>(
    server,
    {
      id: (ws) => ws.data?.id,
      setupContext: setupContext
        ? (ctx, ws) => setupContext(ctx, ws.data.req)
        : undefined,
      onOpen: onOpen ? (conn, ws) => onOpen(conn, ws.data.req) : undefined,
      onClose: onClose
        ? (conn, ws, reason) => onClose(conn, ws.data.req, reason)
        : undefined,
    }
  )

  return {
    async fetch(
      req: Request,
      srv: BunServerLike
    ): Promise<Response | undefined> {
      if (path !== undefined && new URL(req.url).pathname !== path) {
        return new Response('Not Found', { status: 404 })
      }

      if (
        req.method === 'GET' &&
        req.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        let clientId: string | undefined
        if (resolveId) {
          try {
            clientId = await resolveId(req)
          } catch {
            return new Response('Internal Server Error', { status: 500 })
          }
        }
        const upgraded = srv.upgrade(req, {
          data: { id: clientId, req } satisfies BunWebSocketData,
        })
        return upgraded
          ? undefined
          : new Response('WebSocket upgrade failed', { status: 400 })
      }

      return httpHandler(req)
    },
    websocket,
  }
}
