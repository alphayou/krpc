import type { JsonRpcId, JsonRpcParams } from '../protocol/types'
import type { CallArgs, NotifyDef, ValidRpcParams } from './method'

const CONTEXT_BRAND: unique symbol = /*#__PURE__*/ Symbol.for('krpc.context')

/** Typed context token without a default value (`ctx.get` returns `T | undefined`). */
export interface ContextToken<T> {
  /** Internal brand identifying a context token. */
  readonly [CONTEXT_BRAND]: true
  /** Unique symbol key for map lookup. */
  readonly id: symbol
  /** Indicates this token has no default value. */
  readonly hasDefault: false
  /** Phantom type marker. */
  readonly _type?: T
}

/** Typed context token with a default value (`ctx.get` always returns `T`). */
export interface ContextTokenWithDefault<T> {
  /** Internal brand identifying a context token. */
  readonly [CONTEXT_BRAND]: true
  /** Unique symbol key for map lookup. */
  readonly id: symbol
  /** Indicates this token provides a default value. */
  readonly hasDefault: true
  /** Default value returned when unset on the current request. */
  readonly defaultValue: T
  /** Phantom type marker. */
  readonly _type?: T
}

/** Union of required and defaulted context tokens. */
export type AnyContextToken<T = any> =
  ContextToken<T> | ContextTokenWithDefault<T>

/** Define a typed context token without a default value. */
export function defineContext<T>(): ContextToken<T>

/** Define a typed context token with a fallback `defaultValue`. */
export function defineContext<T>(defaultValue: T): ContextTokenWithDefault<T>

export function defineContext<T>(
  ...args: [] | [T]
): ContextToken<T> | ContextTokenWithDefault<T> {
  const id = Symbol('krpc.ctx')
  if (args.length === 0) {
    return {
      [CONTEXT_BRAND]: true,
      id,
      hasDefault: false,
    }
  }
  return {
    [CONTEXT_BRAND]: true,
    id,
    hasDefault: true,
    defaultValue: args[0] as T,
  }
}

/** Request-scoped execution context passed to RPC handlers and lifecycle hooks. */
export interface RpcContext {
  /** Read a defaulted context token, returning its default if unset. */
  get<T>(token: ContextTokenWithDefault<T>): T
  /** Read a context token, returning `undefined` if unset. */
  get<T>(token: ContextToken<T>): T | undefined
  /** Read a context token or throw if neither set nor defaulted. */
  require<T>(token: ContextToken<T> | ContextTokenWithDefault<T>): T
  /** Bind a value for the given context token on the current request. */
  set<T>(token: ContextToken<T> | ContextTokenWithDefault<T>, value: T): void
  /** Check whether a value is available (set or defaulted) for the token. */
  has(token: AnyContextToken): boolean
  /** Cancellation signal for the current request (e.g. HTTP `req.signal`). */
  readonly signal: AbortSignal
  /** Resolved JSON-RPC method name currently being executed. */
  readonly method: string
  /** Request `id`, or `undefined` when invoked as a JSON-RPC Notification. */
  readonly id: JsonRpcId | undefined
  /** `true` when invoked as a JSON-RPC Notification (no `id`, no reply). */
  readonly isNotification: boolean
  /** `true` when the active transport supports outbound `ctx.notify(...)` pushes. */
  readonly canNotify: boolean
  /** Emit a typed outbound Notification declared with `defineNotify`. */
  notify<Input extends ValidRpcParams>(
    def: NotifyDef<Input, any>,
    ...args: CallArgs<Input>
  ): Promise<void>
}

/** Options used by `createServer` to instantiate a request-scoped `RpcContext`. */
export interface CreateRpcContextOptions {
  /** Resolved JSON-RPC method name. */
  readonly method: string
  /** Request identifier, or `undefined` for Notifications. */
  readonly id: JsonRpcId | undefined
  /** Whether the call is a Notification. */
  readonly isNotification: boolean
  /** Optional cancellation signal (defaults to a non-aborted signal). */
  readonly signal?: AbortSignal
  /** Optional outbound notification dispatcher for full-duplex transports. */
  readonly sendNotify?: (
    def: NotifyDef<any, any>,
    params: JsonRpcParams | undefined
  ) => Promise<void>
}

let defaultSignal: AbortSignal | undefined

function getDefaultSignal(): AbortSignal {
  return (defaultSignal ??= new AbortController().signal)
}

/** Create a request-scoped `RpcContext` instance. */
export function createRpcContext(options: CreateRpcContextOptions): RpcContext {
  let values: Map<symbol, unknown> | undefined
  const signal = options.signal ?? getDefaultSignal()
  const { method, id, isNotification, sendNotify } = options

  function get<T>(token: ContextTokenWithDefault<T>): T
  function get<T>(token: ContextToken<T>): T | undefined
  function get<T>(
    token: ContextToken<T> | ContextTokenWithDefault<T>
  ): T | undefined {
    if (values?.has(token.id)) {
      return values.get(token.id) as T
    }
    return token.hasDefault ? token.defaultValue : undefined
  }

  return {
    get,
    require<T>(token: ContextToken<T> | ContextTokenWithDefault<T>): T {
      if (values?.has(token.id)) {
        return values.get(token.id) as T
      }
      if (token.hasDefault) {
        return token.defaultValue
      }
      throw new Error(
        `Required context token is missing for method "${method}"`
      )
    },
    set<T>(token: ContextToken<T> | ContextTokenWithDefault<T>, value: T) {
      ;(values ??= new Map()).set(token.id, value)
    },
    has(token: AnyContextToken): boolean {
      return (values?.has(token.id) ?? false) || token.hasDefault
    },
    signal,
    method,
    id,
    isNotification,
    canNotify: sendNotify !== undefined,
    async notify<Input extends ValidRpcParams>(
      def: NotifyDef<Input, any>,
      ...args: CallArgs<Input>
    ): Promise<void> {
      if (!sendNotify) {
        throw new Error(
          'Outbound notifications are not supported by the active transport'
        )
      }
      await sendNotify(def, args[0] as JsonRpcParams | undefined)
    },
  }
}
