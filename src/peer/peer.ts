import {
  batchBuilder,
  runWithCallOptions,
  type BatchBuilder,
  type BatchItem,
  type BatchResults,
  type CallArgsWithOptions,
  type CallOptions,
  type ClientOptions,
} from '../client/client'
import {
  invalidRequest,
  KrpcTransportError,
  methodNotFound,
  stringifyJsonRpcResponse,
} from '../protocol/errors'
import {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpcPayload,
} from '../protocol/guards'
import { validateStandardSchema } from '../protocol/standard-schema'
import {
  err,
  ok,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcResponsePayload,
  type JsonRpcSingleRequest,
  type Result,
} from '../protocol/types'
import {
  createServer,
  type HandleOptions,
  type RpcServer,
  type ServerOptions,
} from '../server/server'
import type { RpcContext } from '../service/context'
import {
  isNotifyDef,
  type CallArgs,
  type NotifyDef,
  type ValidRpcParams,
} from '../service/method'
import type { ServiceTree } from '../service/service'
import type {
  InferError,
  InferInput,
  InferNotify,
  InferOutput,
  MethodNames,
  NotifyNames,
  UntypedService,
} from '../service/types'
import type { DuplexTransport } from '../transports/types'

/** Configuration options for `createPeer`. */
export interface PeerOptions extends ClientOptions, ServerOptions {
  /** Optional client/connection identifier exposed on `ctx.clientId` for inbound calls. */
  readonly id?: string
  /** Populate request-scoped context tokens for every inbound RPC invocation. */
  readonly setupContext?: (ctx: RpcContext) => void | Promise<void>
}

/** Union of string names accepted by `peer.notify` (local outbound notifications or remote methods). */
export type PeerNotifyNames<RemoteApp, LocalApp> =
  NotifyNames<LocalApp> | MethodNames<RemoteApp>

/** Payload type resolved for a string `peer.notify` name. */
export type PeerNotifyInput<RemoteApp, LocalApp, K extends string> =
  K extends NotifyNames<LocalApp>
    ? InferNotify<LocalApp, K>
    : K extends MethodNames<RemoteApp>
      ? InferInput<RemoteApp, K>
      : never

/** Handler callback subscribed via `peer.on(name, handler)`. */
export type PeerNotifyHandler<Payload> = [Payload] extends [void | undefined]
  ? () => void | Promise<void>
  : (payload: Payload) => void | Promise<void>

/** Full-duplex JSON-RPC 2.0 peer created by `createPeer`. */
export interface KrpcPeer<RemoteApp = UntypedService, LocalApp = never> {
  /** Phantom remote service type carrier enabling `createProxy(peer)` type inference. */
  readonly _app?: RemoteApp
  /** Invoke a remote RPC method and resolve to a typed `Result`. */
  call<K extends MethodNames<RemoteApp>>(
    method: K,
    ...args: CallArgsWithOptions<InferInput<RemoteApp, K>>
  ): Promise<Result<InferOutput<RemoteApp, K>, InferError<RemoteApp, K>>>
  /** Execute a typed JSON-RPC 2.0 batch against the remote peer. */
  batch<const T extends readonly BatchItem[]>(
    build: (b: BatchBuilder<RemoteApp>) => T,
    options?: CallOptions
  ): Promise<BatchResults<T>>
  /** Push a local outbound notification by its `defineNotify` contract reference. */
  notify<Input extends ValidRpcParams>(
    def: NotifyDef<Input, any>,
    ...args: CallArgs<Input>
  ): Promise<void>
  /** Push a local outbound notification by dot-path or call a remote method as a Notification. */
  notify<K extends PeerNotifyNames<RemoteApp, LocalApp>>(
    name: K,
    ...args: CallArgs<PeerNotifyInput<RemoteApp, LocalApp, K>>
  ): Promise<void>
  /** Subscribe to an inbound outbound notification declared on `RemoteApp`. Returns an unsubscribe function. */
  on<K extends NotifyNames<RemoteApp>>(
    name: K,
    handler: PeerNotifyHandler<InferNotify<RemoteApp, K>>
  ): () => void
  /** Close the underlying `DuplexTransport`, rejecting all in-flight calls and releasing listeners. */
  close(): Promise<void>
}

interface PendingCall {
  resolve: (response: JsonRpcResponse) => void
  reject: (reason: unknown) => void
}

interface PendingBatch {
  readonly ids: ReadonlyMap<JsonRpcId, number>
  readonly results: Array<Result<any, any> | undefined>
  matched: number
  resolve: (results: Array<Result<any, any> | undefined>) => void
  reject: (reason: unknown) => void
}

function isRpcServer(value: unknown): value is RpcServer<any> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.handle === 'function' &&
    typeof candidate.handleRaw === 'function' &&
    typeof candidate.resolveNotify === 'function'
  )
}

/**
 * Create a full-duplex JSON-RPC 2.0 peer over any `DuplexTransport`
 * (WebSocket, Web Streams, or in-memory duplex pair), defaulting to
 * `UntypedService` when calling an external JSON-RPC 2.0 server without an `App` type.
 */
export function createPeer<RemoteApp = UntypedService>(
  transport: DuplexTransport,
  local?: undefined,
  options?: PeerOptions
): KrpcPeer<RemoteApp, never>

/**
 * Create a full-duplex JSON-RPC 2.0 peer serving a local `ServiceTree` or `RpcServer`
 * over any `DuplexTransport`.
 */
export function createPeer<
  RemoteApp = never,
  LocalApp extends ServiceTree = ServiceTree,
>(
  transport: DuplexTransport,
  local: LocalApp | RpcServer<LocalApp>,
  options?: PeerOptions
): KrpcPeer<RemoteApp, LocalApp>

export function createPeer(
  transport: DuplexTransport,
  local?: ServiceTree | RpcServer<any>,
  options: PeerOptions = {}
): KrpcPeer<any, any> {
  const defaultTimeout = options.timeout
  let seq = 0
  const nextId = options.nextId ?? (() => ++seq)

  const server: RpcServer<any> | undefined = local
    ? isRpcServer(local)
      ? local
      : createServer(local, options)
    : undefined

  const pendingCalls = new Map<JsonRpcId, PendingCall>()
  const pendingBatches = new Set<PendingBatch>()
  const batchById = new Map<JsonRpcId, PendingBatch>()
  const listeners = new Map<string, Set<(params: unknown) => void>>()
  let closed = false

  const sendFrame = async (payload: unknown): Promise<void> => {
    if (closed) {
      throw new KrpcTransportError('Transport closed')
    }
    try {
      await transport.send(JSON.stringify(payload))
    } catch (caught) {
      if (caught instanceof KrpcTransportError) {
        throw caught
      }
      throw new KrpcTransportError('Failed to send JSON-RPC frame', {
        cause: caught,
      })
    }
  }

  const sendFrameBestEffort = (payload: unknown): void => {
    if (closed) return
    try {
      const maybePromise = transport.send(JSON.stringify(payload))
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {})
      }
    } catch {
      // Transport closed while replying to an inbound frame.
    }
  }

  const sendResponseBestEffort = async (
    payload: JsonRpcResponsePayload
  ): Promise<void> => {
    if (closed) return
    try {
      await transport.send(stringifyJsonRpcResponse(payload))
    } catch {
      // Transport closed while replying to an inbound frame.
    }
  }

  const handleOpts: HandleOptions = {
    clientId: options.id,
    setupContext: options.setupContext,
    emitNotify(method, params) {
      if (closed) return false
      const frame: JsonRpcNotification =
        params === undefined
          ? { jsonrpc: '2.0', method }
          : { jsonrpc: '2.0', method, params }
      return sendFrame(frame).then(
        () => true,
        () => false
      )
    },
  }

  const dispatchToServer = async (value: unknown): Promise<void> => {
    if (!server) return
    let flushAfter: (() => Promise<void>) | undefined
    const response = await server.handle(value, {
      ...handleOpts,
      onAfterTasks(flush) {
        flushAfter = flush
      },
    })
    if (response !== undefined) {
      await sendResponseBestEffort(response)
    }
    if (flushAfter) {
      void flushAfter()
    }
  }

  const dispatchSubscribers = (method: string, params: unknown): void => {
    const subs = listeners.get(method)
    if (!subs || subs.size === 0) return
    for (const handler of [...subs]) {
      try {
        const res = handler(params) as unknown
        if (
          res !== null &&
          typeof res === 'object' &&
          'catch' in res &&
          typeof (res as Promise<unknown>).catch === 'function'
        ) {
          ;(res as Promise<unknown>).catch(() => {})
        }
      } catch {
        // Isolate subscriber exceptions from protocol routing.
      }
    }
  }

  const removePendingBatch = (pending: PendingBatch): void => {
    pendingBatches.delete(pending)
    for (const id of pending.ids.keys()) {
      batchById.delete(id)
    }
  }

  const handleResponseEntry = (entry: JsonRpcResponse): void => {
    const single = pendingCalls.get(entry.id)
    if (single) {
      pendingCalls.delete(entry.id)
      single.resolve(entry)
      return
    }

    const batchEntry = batchById.get(entry.id)
    if (!batchEntry) return

    const slot = batchEntry.ids.get(entry.id)
    if (slot === undefined) return
    if (batchEntry.results[slot] !== undefined) {
      removePendingBatch(batchEntry)
      batchEntry.reject(
        new KrpcTransportError(
          `Duplicate JSON-RPC response id in batch: ${String(entry.id)}`
        )
      )
      return
    }

    batchEntry.results[slot] = isJsonRpcErrorResponse(entry)
      ? err(entry.error)
      : ok(entry.result)
    batchEntry.matched++

    if (batchEntry.matched === batchEntry.ids.size) {
      removePendingBatch(batchEntry)
      batchEntry.resolve(batchEntry.results)
    }
  }

  const handleResponseBatch = (entries: readonly JsonRpcResponse[]): void => {
    const touchedBatches = new Set<PendingBatch>()
    const seenIds = new Set<JsonRpcId>()
    const duplicateBatches = new Map<PendingBatch, JsonRpcId>()

    for (const entry of entries) {
      const batchEntry = batchById.get(entry.id)
      if (!batchEntry) continue
      if (seenIds.has(entry.id)) {
        duplicateBatches.set(batchEntry, entry.id)
      } else {
        seenIds.add(entry.id)
        touchedBatches.add(batchEntry)
      }
    }

    for (const [batchEntry, dupId] of duplicateBatches) {
      removePendingBatch(batchEntry)
      batchEntry.reject(
        new KrpcTransportError(
          `Duplicate JSON-RPC response id in batch: ${String(dupId)}`
        )
      )
    }

    for (const entry of entries) {
      handleResponseEntry(entry)
    }

    for (const batchEntry of touchedBatches) {
      if (pendingBatches.has(batchEntry)) {
        removePendingBatch(batchEntry)
        batchEntry.reject(
          new KrpcTransportError(
            `Incomplete JSON-RPC batch response: expected ${batchEntry.ids.size} responses, received ${batchEntry.matched}`
          )
        )
      }
    }
  }

  const handleInboundFrame = async (raw: string): Promise<void> => {
    const parsed = parseJsonRpcPayload(raw)
    if (!parsed.ok) {
      sendFrameBestEffort({
        jsonrpc: '2.0',
        id: null,
        error: parsed.error.toJSON(),
      })
      return
    }

    const value = parsed.value

    if (Array.isArray(value)) {
      if (value.every(isJsonRpcResponse)) {
        handleResponseBatch(value)
        return
      }

      for (const item of value) {
        if (isJsonRpcNotification(item)) {
          dispatchSubscribers(item.method, item.params)
        }
      }

      if (server) {
        await dispatchToServer(value)
        return
      }

      const fallbackResponses: JsonRpcResponse[] = []
      for (const item of value) {
        if (isJsonRpcNotification(item)) continue
        if (isJsonRpcRequest(item)) {
          fallbackResponses.push({
            jsonrpc: '2.0',
            id: item.id,
            error: methodNotFound().toJSON(),
          })
        } else {
          fallbackResponses.push({
            jsonrpc: '2.0',
            id: null,
            error: invalidRequest().toJSON(),
          })
        }
      }
      if (fallbackResponses.length > 0) {
        sendFrameBestEffort(fallbackResponses)
      }
      return
    }

    if (isJsonRpcResponse(value)) {
      handleResponseEntry(value)
      return
    }

    if (isJsonRpcNotification(value)) {
      dispatchSubscribers(value.method, value.params)
      if (server) {
        await dispatchToServer(value)
      }
      return
    }

    if (server) {
      await dispatchToServer(value)
      return
    }

    if (isJsonRpcRequest(value)) {
      sendFrameBestEffort({
        jsonrpc: '2.0',
        id: value.id,
        error: methodNotFound().toJSON(),
      })
      return
    }

    sendFrameBestEffort({
      jsonrpc: '2.0',
      id: null,
      error: invalidRequest().toJSON(),
    })
  }

  let offMessage: (() => void) | undefined
  let offClose: (() => void) | undefined

  const cleanupOnClose = (): void => {
    if (closed) return
    closed = true
    offMessage?.()
    offClose?.()
    offMessage = undefined
    offClose = undefined

    const closeErr = new KrpcTransportError('Transport closed')

    for (const pending of pendingCalls.values()) {
      pending.reject(closeErr)
    }
    pendingCalls.clear()

    for (const pending of pendingBatches) {
      pending.reject(closeErr)
    }
    pendingBatches.clear()
    batchById.clear()
    listeners.clear()
  }

  offMessage = transport.onMessage((message) => {
    void handleInboundFrame(message)
  })
  offClose = transport.onClose(() => {
    cleanupOnClose()
  })

  const call = async (
    method: string,
    params?: JsonRpcParams,
    callOptions?: CallOptions
  ): Promise<Result<any, any>> => {
    if (closed) {
      throw new KrpcTransportError('Transport closed')
    }

    const id = nextId()
    const request: JsonRpcRequest =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params }

    const response = await runWithCallOptions(
      () =>
        new Promise<JsonRpcResponse>((resolve, reject) => {
          pendingCalls.set(id, { resolve, reject })
          sendFrame(request).catch((sendErr) => {
            pendingCalls.delete(id)
            reject(sendErr)
          })
        }),
      defaultTimeout,
      callOptions
    ).catch((reason) => {
      pendingCalls.delete(id)
      throw reason
    })

    return isJsonRpcErrorResponse(response)
      ? err(response.error)
      : ok(response.result)
  }

  const batch = async <const T extends readonly BatchItem[]>(
    build: (b: BatchBuilder<any>) => T,
    callOptions?: CallOptions
  ): Promise<BatchResults<T>> => {
    const items = build(batchBuilder as BatchBuilder<any>)
    if (items.length === 0) {
      return [] as unknown as BatchResults<T>
    }
    if (closed) {
      throw new KrpcTransportError('Transport closed')
    }

    const payload: JsonRpcSingleRequest[] = new Array(items.length)
    const idToSlot = new Map<JsonRpcId, number>()
    const results = new Array<Result<any, any> | undefined>(items.length)

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as BatchItem
      if (item.kind === 'call') {
        const id = nextId()
        if (idToSlot.has(id)) {
          throw new KrpcTransportError(
            `Duplicate JSON-RPC request id in batch: ${String(id)}`
          )
        }
        idToSlot.set(id, i)
        payload[i] =
          item.params === undefined
            ? { jsonrpc: '2.0', id, method: item.method }
            : { jsonrpc: '2.0', id, method: item.method, params: item.params }
      } else {
        payload[i] =
          item.params === undefined
            ? { jsonrpc: '2.0', method: item.method }
            : { jsonrpc: '2.0', method: item.method, params: item.params }
      }
    }

    if (idToSlot.size === 0) {
      await runWithCallOptions(
        () => sendFrame(payload),
        defaultTimeout,
        callOptions
      )
      return results as unknown as BatchResults<T>
    }

    let pendingRef: PendingBatch | undefined
    const resolved = await runWithCallOptions(
      () =>
        new Promise<Array<Result<any, any> | undefined>>((resolve, reject) => {
          const pending: PendingBatch = {
            ids: idToSlot,
            results,
            matched: 0,
            resolve,
            reject,
          }
          pendingRef = pending
          pendingBatches.add(pending)
          for (const id of idToSlot.keys()) {
            batchById.set(id, pending)
          }

          sendFrame(payload).catch((sendErr) => {
            removePendingBatch(pending)
            reject(sendErr)
          })
        }),
      defaultTimeout,
      callOptions
    ).catch((reason) => {
      if (pendingRef) {
        removePendingBatch(pendingRef)
      }
      throw reason
    })

    return resolved as unknown as BatchResults<T>
  }

  const notify = async (
    target: NotifyDef | string,
    params?: JsonRpcParams
  ): Promise<void> => {
    let method: string
    let outboundParams: JsonRpcParams | undefined = params

    if (isNotifyDef(target)) {
      const resolved = server?.resolveNotify(target)
      if (!resolved) {
        throw new Error(
          'Notification definition is not registered in this peer service'
        )
      }
      method = resolved.name
      if (resolved.def.schema) {
        const validated = await validateStandardSchema(
          resolved.def.schema,
          params
        )
        if (!validated.ok) {
          throw new Error(
            `Invalid outbound notification params for "${method}": ${validated.issues.map((i) => i.message).join(', ')}`
          )
        }
        outboundParams = validated.value as JsonRpcParams | undefined
      }
    } else {
      method = target
      const resolved = server?.resolveNotify(target)
      if (resolved?.def.schema) {
        const validated = await validateStandardSchema(
          resolved.def.schema,
          params
        )
        if (!validated.ok) {
          throw new Error(
            `Invalid outbound notification params for "${method}": ${validated.issues.map((i) => i.message).join(', ')}`
          )
        }
        outboundParams = validated.value as JsonRpcParams | undefined
      }
    }

    const frame: JsonRpcNotification =
      outboundParams === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params: outboundParams }
    await sendFrame(frame)
  }

  const on = (
    name: string,
    handler: (payload: unknown) => void | Promise<void>
  ): (() => void) => {
    let subs = listeners.get(name)
    if (!subs) {
      subs = new Set()
      listeners.set(name, subs)
    }
    subs.add(handler)
    return () => {
      subs.delete(handler)
      if (subs.size === 0) {
        listeners.delete(name)
      }
    }
  }

  const close = async (): Promise<void> => {
    cleanupOnClose()
    await transport.close()
  }

  return {
    call: call as KrpcPeer<any, any>['call'],
    batch,
    notify: notify as KrpcPeer<any, any>['notify'],
    on: on as KrpcPeer<any, any>['on'],
    close,
  }
}
