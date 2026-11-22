import {
  internalError,
  invalidParams,
  invalidRequest,
  isJsonRpcError,
  isRpcErrorValue,
  methodNotFound,
  type JsonRpcError,
} from '../protocol/errors'
import {
  isJsonRpcId,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isPlainObject,
  isReservedRpcMethod,
  parseJsonRpcPayload,
} from '../protocol/guards'
import { validateStandardSchema } from '../protocol/standard-schema'
import type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcParams,
  JsonRpcResponse,
  JsonRpcResponsePayload,
} from '../protocol/types'
import { createRpcContext, type RpcContext } from '../service/context'
import type { AfterHook, BeforeHook, ErrorHook } from '../service/hooks'
import type { MethodDef, NotifyDef } from '../service/method'
import { compileService, type ServiceTree } from '../service/service'

/** Configuration options for `createServer`. */
export interface ServerOptions {
  /** Maximum number of items allowed in a single batch payload (default: `100`). */
  readonly maxBatchSize?: number
  /** Maximum concurrent item executions within a batch (default: `Infinity`; `1` runs sequentially). */
  readonly batchConcurrency?: number
  /** Allow invoking JSON-RPC reserved `rpc.*` method names (default: `false`). */
  readonly allowReservedMethods?: boolean
  /** Custom formatter mapping unexpected thrown errors to a JSON-RPC error object. */
  readonly formatError?: (
    error: unknown,
    ctx: RpcContext
  ) => JsonRpcError | JsonRpcErrorObject
}

/** Per-invocation options passed to `server.handle` or `server.handleRaw`. */
export interface HandleOptions {
  /** Request-level cancellation signal forwarded to `ctx.signal`. */
  readonly signal?: AbortSignal
  /** Populate request-scoped context tokens before hooks and handlers run. */
  readonly setupContext?: (ctx: RpcContext) => void | Promise<void>
  /** Outbound notification emitter wired by full-duplex transports (e.g. `createPeer`). */
  readonly emitNotify?: (
    method: string,
    params?: JsonRpcParams
  ) => void | Promise<void>
}

/** Resolved outbound notification entry returned by `server.resolveNotify`. */
export interface ResolvedNotify {
  /** Dot-separated notification name in the compiled service. */
  readonly name: string
  /** Underlying `NotifyDef` contract (including optional Standard Schema validator). */
  readonly def: NotifyDef
}

/** JSON-RPC 2.0 server instance created by `createServer`. */
export interface RpcServer<S extends ServiceTree = ServiceTree> {
  /** Original service tree passed to `createServer`. */
  readonly service: S
  /** Dispatch a parsed JSON-RPC 2.0 payload (single message or batch array). */
  handle(
    payload: unknown,
    options?: HandleOptions
  ): Promise<JsonRpcResponsePayload | undefined>
  /** Parse a raw JSON string and dispatch it as a JSON-RPC 2.0 payload. */
  handleRaw(
    text: string,
    options?: HandleOptions
  ): Promise<JsonRpcResponsePayload | undefined>
  /** Look up a registered outbound notification by its `NotifyDef` reference or dot-separated name. */
  resolveNotify(defOrName: NotifyDef | string): ResolvedNotify | undefined
}

function errorResponse(
  id: JsonRpcId,
  error: JsonRpcErrorObject
): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error }
}

function toWireError(
  caught: unknown,
  ctx: RpcContext,
  formatError?: ServerOptions['formatError']
): JsonRpcErrorObject {
  if (isRpcErrorValue(caught)) {
    return caught.data === undefined
      ? { code: caught.code, message: caught.message }
      : { code: caught.code, message: caught.message, data: caught.data }
  }
  if (isJsonRpcError(caught)) {
    return caught.toJSON()
  }
  if (formatError) {
    const formatted = formatError(caught, ctx)
    return isJsonRpcError(formatted) ? formatted.toJSON() : formatted
  }
  return internalError().toJSON()
}

function extractInvalidRequestId(item: unknown): JsonRpcId {
  if (
    isPlainObject(item) &&
    item.jsonrpc === '2.0' &&
    Object.prototype.hasOwnProperty.call(item, 'id') &&
    isJsonRpcId(item.id)
  ) {
    return item.id
  }
  return null
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit >= items.length) {
    return Promise.all(items.map(worker))
  }

  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length))

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const current = nextIndex++
        results[current] = await worker(items[current] as T)
      }
    })
  )

  return results
}

interface PreparedMethod {
  readonly def: MethodDef
  readonly before: readonly BeforeHook[]
  readonly after: readonly AfterHook[]
  readonly error: readonly ErrorHook[]
}

function prepareMethods(
  methods: ReadonlyMap<string, MethodDef>
): Map<string, PreparedMethod> {
  const prepared = new Map<string, PreparedMethod>()
  for (const [name, def] of methods) {
    const before: BeforeHook[] = []
    const after: AfterHook[] = []
    const error: ErrorHook[] = []

    for (const layer of def.hooks) {
      before.push(...layer.before)
    }
    for (let i = def.hooks.length - 1; i >= 0; i--) {
      const layer = def.hooks[i]
      if (!layer) continue
      after.push(...layer.after)
      error.push(...layer.error)
    }

    prepared.set(name, { def, before, after, error })
  }
  return prepared
}

/** Create a JSON-RPC 2.0 server from a `defineService` service tree. */
export function createServer<S extends ServiceTree>(
  service: S,
  options: ServerOptions = {}
): RpcServer<S> {
  const maxBatchSize = options.maxBatchSize ?? 100
  const batchConcurrency = options.batchConcurrency ?? Number.POSITIVE_INFINITY
  const allowReservedMethods = options.allowReservedMethods ?? false
  const { formatError } = options

  const compiled = compileService(service)
  const preparedMethods = prepareMethods(compiled.methods)

  const resolveNotify = (
    defOrName: NotifyDef | string
  ): ResolvedNotify | undefined => {
    if (typeof defOrName === 'string') {
      const def = compiled.notifiesByName.get(defOrName)
      return def ? { name: defOrName, def } : undefined
    }
    const name = compiled.notifyNames.get(defOrName)
    return name ? { name, def: defOrName } : undefined
  }

  const runErrorHooks = async (
    hooks: readonly ErrorHook[],
    error: unknown,
    ctx: RpcContext
  ): Promise<void> => {
    for (const hook of hooks) {
      try {
        await hook(error, ctx)
      } catch {
        // Keep original RPC error intact if an error observer throws.
      }
    }
  }

  const handleSingle = async (
    item: unknown,
    handleOptions?: HandleOptions
  ): Promise<JsonRpcResponse | undefined> => {
    const isReq = isJsonRpcRequest(item)
    const isNotif = !isReq && isJsonRpcNotification(item)

    if (!isReq && !isNotif) {
      return errorResponse(
        extractInvalidRequestId(item),
        invalidRequest().toJSON()
      )
    }

    const isNotification = isNotif
    const id = isReq ? item.id : undefined

    if (!allowReservedMethods && isReservedRpcMethod(item.method)) {
      return isNotification
        ? undefined
        : errorResponse(id as JsonRpcId, methodNotFound().toJSON())
    }

    const prepared = preparedMethods.get(item.method)
    if (!prepared) {
      return isNotification
        ? undefined
        : errorResponse(id as JsonRpcId, methodNotFound().toJSON())
    }
    const { def: methodDef, before, after, error: errorHooks } = prepared

    const emitNotify = handleOptions?.emitNotify
    const sendNotify = emitNotify
      ? async (def: NotifyDef, params: JsonRpcParams | undefined) => {
          const name = compiled.notifyNames.get(def)
          if (!name) {
            throw new Error(
              'Notification definition is not registered in this service'
            )
          }
          if (def.schema) {
            const validated = await validateStandardSchema(def.schema, params)
            if (!validated.ok) {
              throw new Error(
                `Invalid outbound notification params for "${name}": ${validated.issues.map((i) => i.message).join(', ')}`
              )
            }
            await emitNotify(name, validated.value as JsonRpcParams | undefined)
            return
          }
          await emitNotify(name, params)
        }
      : undefined

    const ctx = createRpcContext({
      method: item.method,
      id,
      isNotification,
      signal: handleOptions?.signal,
      sendNotify,
    })

    try {
      if (handleOptions?.setupContext) {
        await handleOptions.setupContext(ctx)
      }

      for (const hook of before) {
        const beforeResult = await hook(ctx)
        if (isRpcErrorValue(beforeResult)) {
          await runErrorHooks(errorHooks, beforeResult, ctx)
          return isNotification
            ? undefined
            : errorResponse(
                id as JsonRpcId,
                toWireError(beforeResult, ctx, formatError)
              )
        }
      }

      let input: unknown = item.params
      if (methodDef.inputSchema) {
        const validated = await validateStandardSchema(
          methodDef.inputSchema,
          item.params
        )
        if (!validated.ok) {
          const paramErr = invalidParams('Invalid params', {
            issues: validated.issues,
          })
          await runErrorHooks(errorHooks, paramErr, ctx)
          return isNotification
            ? undefined
            : errorResponse(id as JsonRpcId, paramErr.toJSON())
        }
        input = validated.value
      }

      let result = await methodDef.handler(input, ctx)

      if (isRpcErrorValue(result)) {
        await runErrorHooks(errorHooks, result, ctx)
        return isNotification
          ? undefined
          : errorResponse(
              id as JsonRpcId,
              toWireError(result, ctx, formatError)
            )
      }

      if (methodDef.outputSchema) {
        const validated = await validateStandardSchema(
          methodDef.outputSchema,
          result
        )
        if (!validated.ok) {
          throw internalError()
        }
        result = validated.value
      }

      for (const hook of after) {
        await hook(result, ctx)
      }

      if (isNotification) {
        return undefined
      }

      return {
        jsonrpc: '2.0',
        id: id as JsonRpcId,
        result: result === undefined ? null : result,
      }
    } catch (caught) {
      await runErrorHooks(errorHooks, caught, ctx)
      if (isNotification) {
        return undefined
      }
      return errorResponse(
        id as JsonRpcId,
        toWireError(caught, ctx, formatError)
      )
    }
  }

  const handle = async (
    payload: unknown,
    handleOptions?: HandleOptions
  ): Promise<JsonRpcResponsePayload | undefined> => {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return errorResponse(null, invalidRequest().toJSON())
      }
      if (payload.length > maxBatchSize) {
        return errorResponse(
          null,
          invalidRequest(
            `Batch size exceeds maximum of ${maxBatchSize}`
          ).toJSON()
        )
      }

      const rawResponses = await runWithConcurrency(
        payload,
        batchConcurrency,
        (entry) => handleSingle(entry, handleOptions)
      )
      const responses = rawResponses.filter(
        (res): res is JsonRpcResponse => res !== undefined
      )
      return responses.length > 0 ? responses : undefined
    }

    return handleSingle(payload, handleOptions)
  }

  const handleRaw = async (
    text: string,
    handleOptions?: HandleOptions
  ): Promise<JsonRpcResponsePayload | undefined> => {
    const parsed = parseJsonRpcPayload(text)
    if (!parsed.ok) {
      return errorResponse(null, parsed.error.toJSON())
    }
    return handle(parsed.value, handleOptions)
  }

  return {
    service,
    handle,
    handleRaw,
    resolveNotify,
  }
}
