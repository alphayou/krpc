import type { RPC_ERROR_BRAND, RpcErrorValue } from '../protocol/errors'
import type { StandardRpcError } from '../protocol/types'
import type { CallArgs, MethodDef, NotifyDef, ValidRpcParams } from './method'
import type { ServiceTree } from './service'

export type { CallArgs, ValidRpcParams }

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
export type FlattenService<S> = [FlattenEntries<S>] extends [never]
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
export type MethodNames<S> = keyof MethodMap<S> & string

/** Union of all dot-separated outbound notification names in service `S`. */
export type NotifyNames<S> = keyof NotifyMap<S> & string

/** Infer the caller input parameter type for method `K` of service `S`. */
export type InferInput<S, K extends MethodNames<S>> =
  MethodMap<S>[K] extends MethodDef<infer Input, any> ? Input : never

/** Infer the success result value type for method `K` of service `S`. */
export type InferOutput<S, K extends MethodNames<S>> =
  MethodMap<S>[K] extends MethodDef<any, infer RawReturn>
    ? Exclude<RawReturn, RpcErrorValue>
    : never

/**
 * Infer the client error union for method `K` of service `S`
 * (returned `defineError` domain errors combined with `StandardRpcError`).
 */
export type InferError<S, K extends MethodNames<S>> =
  MethodMap<S>[K] extends MethodDef<any, infer RawReturn>
    ? ToClientError<Extract<RawReturn, RpcErrorValue>> | StandardRpcError
    : StandardRpcError

/** Infer the payload type for outbound notification `K` of service `S`. */
export type InferNotify<S, K extends NotifyNames<S>> =
  NotifyMap<S>[K] extends NotifyDef<infer Input, any> ? Input : never
