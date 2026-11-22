import type { RPC_ERROR_BRAND, RpcErrorValue } from '../protocol/errors'
import type {
  JsonRpcErrorObject,
  JsonRpcParams,
  StandardRpcError,
} from '../protocol/types'
import type {
  CallArgs,
  MethodDef,
  NormalizeRpcResult,
  NotifyDef,
  ValidRpcParams,
} from './method'
import type { ServiceTree } from './service'

export type { CallArgs, NormalizeRpcResult, ValidRpcParams }

declare const UNTYPED_SERVICE_BRAND: unique symbol

/**
 * Default service type for untyped `createClient(transport)` and `createPeer(transport)`
 * instances talking to external JSON-RPC 2.0 servers (e.g. Ethereum, LSP, MCP)
 * without a shared `krpc` `App` type.
 */
export interface UntypedService {
  /** Phantom marker distinguishing untyped external services from typed `ServiceTree`s. */
  readonly [UNTYPED_SERVICE_BRAND]: true
}

/** @internal Detect `UntypedService` without matching `never` or `any`. */
export type IsUntypedService<S> = [S] extends [never]
  ? false
  : 0 extends 1 & S
    ? false
    : [S] extends [UntypedService]
      ? true
      : false

/** Strip the internal brand from an `RpcErrorValue` union to produce plain client error objects. */
export type ToClientError<E> = E extends RpcErrorValue
  ? Omit<E, typeof RPC_ERROR_BRAND>
  : never

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

type Prettify<T> = { [K in keyof T]: T[K] } & {}

type JoinPath<Prefix extends string, Key extends string> = Prefix extends ''
  ? Key
  : `${Prefix}.${Key}`

type FlattenEntries<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends MethodDef
    ? { readonly [P in JoinPath<Prefix, K>]: T[K] }
    : T[K] extends NotifyDef
      ? { readonly [P in JoinPath<Prefix, K>]: T[K] }
      : T[K] extends ServiceTree
        ? FlattenEntries<T[K], JoinPath<Prefix, K>>
        : never
}[keyof T & string]

/** Recursively flatten a nested service tree into dot-separated method and notification entries. */
export type FlattenService<S> = [S] extends [never]
  ? Record<never, never>
  : 0 extends 1 & S
    ? Record<never, never>
    : [FlattenEntries<S>] extends [never]
      ? Record<never, never>
      : Prettify<UnionToIntersection<FlattenEntries<S>>>

/** Map of dot-separated RPC method names to their `MethodDef` entries. */
export type MethodMap<S> = {
  [
    K in keyof FlattenService<S> as FlattenService<S>[K] extends MethodDef
      ? K
      : never
  ]: FlattenService<S>[K] extends MethodDef ? FlattenService<S>[K] : never
}

/** Map of dot-separated outbound notification names to their `NotifyDef` entries. */
export type NotifyMap<S> = {
  [
    K in keyof FlattenService<S> as FlattenService<S>[K] extends NotifyDef
      ? K
      : never
  ]: FlattenService<S>[K] extends NotifyDef ? FlattenService<S>[K] : never
}

/** Union of all callable dot-separated RPC method names in service `S`. */
export type MethodNames<S> =
  IsUntypedService<S> extends true ? string : keyof MethodMap<S> & string

/** Union of all dot-separated outbound notification names in service `S`. */
export type NotifyNames<S> =
  IsUntypedService<S> extends true ? string : keyof NotifyMap<S> & string

/** Infer the caller input parameter type for method `K` of service `S`. */
export type InferInput<S, K extends MethodNames<S>> =
  IsUntypedService<S> extends true
    ? JsonRpcParams | undefined
    : K extends keyof MethodMap<S>
      ? MethodMap<S>[K] extends MethodDef<infer Input, any>
        ? Input
        : never
      : never

/** Infer the success result value type for method `K` of service `S`. */
export type InferOutput<S, K extends MethodNames<S>> =
  IsUntypedService<S> extends true
    ? unknown
    : K extends keyof MethodMap<S>
      ? MethodMap<S>[K] extends MethodDef<any, infer RawReturn>
        ? NormalizeRpcResult<Exclude<RawReturn, RpcErrorValue>>
        : never
      : never

/**
 * Infer the client error union for method `K` of service `S`
 * (returned `defineError` domain errors combined with `StandardRpcError`).
 */
export type InferError<S, K extends MethodNames<S>> =
  IsUntypedService<S> extends true
    ? JsonRpcErrorObject
    : K extends keyof MethodMap<S>
      ? MethodMap<S>[K] extends MethodDef<any, infer RawReturn>
        ? ToClientError<Extract<RawReturn, RpcErrorValue>> | StandardRpcError
        : StandardRpcError
      : StandardRpcError

/** Infer the payload type for outbound notification `K` of service `S`. */
export type InferNotify<S, K extends NotifyNames<S>> =
  IsUntypedService<S> extends true
    ? unknown
    : K extends keyof NotifyMap<S>
      ? NotifyMap<S>[K] extends NotifyDef<infer Input, any>
        ? Input
        : never
      : never
