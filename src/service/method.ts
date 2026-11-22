import type { RpcErrorValue } from '../protocol/errors'
import {
  isStandardSchema,
  type InferInput as InferSchemaInput,
  type InferOutput as InferSchemaOutput,
  type StandardSchemaV1,
} from '../protocol/standard-schema'
import type { RpcContext } from './context'
import type { ServiceHookLayer } from './hooks'

/** Unique symbol identifying a compiled `defineMethod` definition. */
export const METHOD_BRAND: unique symbol =
  /*#__PURE__*/ Symbol.for('krpc.method')

/** Unique symbol identifying a `defineNotify` contract. */
export const NOTIFY_BRAND: unique symbol =
  /*#__PURE__*/ Symbol.for('krpc.notify')

/**
 * Valid JSON-RPC 2.0 `params` type: structured object/interface, array/tuple, or `void`/`undefined`.
 * Primitive values (`string`, `number`, `boolean`, `bigint`, `symbol`, `null`) are rejected at compile time.
 */
export type ValidRpcParams = object | void | undefined

/** Conditional argument tuple for callers: omits `params` for `void` methods and makes optional params optional. */
export type CallArgs<Input> = [Input] extends [void | undefined]
  ? []
  : undefined extends Input
    ? [params?: Exclude<Input, undefined>]
    : [params: Input]

/** Schema options accepted by the `{ input?, output? }` overload of `defineMethod`. */
export interface MethodSchemaOptions<
  InSchema extends StandardSchemaV1<ValidRpcParams, any> | undefined =
    StandardSchemaV1<ValidRpcParams, any> | undefined,
  OutSchema extends StandardSchemaV1<any, any> | undefined =
    StandardSchemaV1<any, any> | undefined,
> {
  /** Optional Standard Schema v1 validator for incoming RPC `params`. */
  readonly input?: InSchema
  /** Optional Standard Schema v1 validator for the handler's success return value. */
  readonly output?: OutSchema
}

/** Runtime and type-level definition created by `defineMethod`. */
export interface MethodDef<Input = any, RawReturn = any> {
  /** Internal brand identifying an RPC method definition. */
  readonly [METHOD_BRAND]: true
  /** Optional Standard Schema v1 validator for incoming `params`. */
  readonly inputSchema?: StandardSchemaV1
  /** Optional Standard Schema v1 validator for outgoing success results. */
  readonly outputSchema?: StandardSchemaV1
  /** Underlying RPC method handler. */
  readonly handler: (input: any, ctx: RpcContext) => unknown
  /** Attached service hook layers ordered outer-to-inner. */
  readonly hooks: readonly ServiceHookLayer[]
  /** Phantom caller input type. */
  readonly _input?: Input
  /** Phantom raw awaited handler return type (including returned `RpcErrorValue`s). */
  readonly _return?: RawReturn
}

/**
 * Normalize a handler's success return type to match JSON-RPC 2.0 wire semantics:
 * `void` and `undefined` serialize as `null` so the required `"result"` member is never omitted.
 */
export type NormalizeRpcResult<T> = [T] extends [never]
  ? never
  : [T] extends [void | undefined]
    ? null
    : undefined extends T
      ? Exclude<T, undefined | void> | null
      : T

/** Extract the success return type of a `MethodDef`, excluding branded `RpcErrorValue`s. */
export type InferMethodValue<M> =
  M extends MethodDef<any, infer RawReturn>
    ? NormalizeRpcResult<Exclude<RawReturn, RpcErrorValue>>
    : never

/** Extract the branded `RpcErrorValue` union returned by a `MethodDef`. */
export type InferMethodErrors<M> =
  M extends MethodDef<any, infer RawReturn>
    ? Extract<RawReturn, RpcErrorValue>
    : never

/** Runtime and type-level outbound Notification contract created by `defineNotify`. */
export interface NotifyDef<Input = any, Output = Input> {
  /** Internal brand identifying a Notification definition. */
  readonly [NOTIFY_BRAND]: true
  /** Optional Standard Schema v1 validator applied when emitting notifications. */
  readonly schema?: StandardSchemaV1
  /** Phantom sender payload input type. */
  readonly _input?: Input
  /** Phantom validated payload output type. */
  readonly _output?: Output
}

/** Runtime type guard for `MethodDef` objects. */
export function isMethodDef(value: unknown): value is MethodDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[METHOD_BRAND] === true
  )
}

/** Runtime type guard for `NotifyDef` objects. */
export function isNotifyDef(value: unknown): value is NotifyDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NOTIFY_BRAND] === true
  )
}

/** Define a JSON-RPC 2.0 method with optional structured `params` and `ctx`. */
export function defineMethod<Input extends ValidRpcParams = void, R = unknown>(
  handler: (input: Input, ctx: RpcContext) => R
): MethodDef<Input, Awaited<R>>

/** Define a JSON-RPC 2.0 method validated by a Standard Schema v1 input schema. */
export function defineMethod<
  S extends StandardSchemaV1<ValidRpcParams, any>,
  R,
>(
  inputSchema: S,
  handler: (input: InferSchemaOutput<S>, ctx: RpcContext) => R
): MethodDef<InferSchemaInput<S>, Awaited<R>>

/** Define a JSON-RPC 2.0 method with a Standard Schema `input` validator and optional `output` validator. */
export function defineMethod<
  InSchema extends StandardSchemaV1<ValidRpcParams, any>,
  OutSchema extends StandardSchemaV1<any, any> | undefined = undefined,
  R = unknown,
>(
  options: {
    /** Standard Schema v1 validator for incoming RPC `params`. */
    readonly input: InSchema
    /** Optional Standard Schema v1 validator for the handler's success return value. */
    readonly output?: OutSchema
  },
  handler: (input: InferSchemaOutput<InSchema>, ctx: RpcContext) => R
): MethodDef<
  InferSchemaInput<InSchema>,
  OutSchema extends StandardSchemaV1<any, any>
    ? InferSchemaOutput<OutSchema> | Extract<Awaited<R>, RpcErrorValue>
    : Awaited<R>
>

/** Define a JSON-RPC 2.0 method with an optional Standard Schema `output` validator and typed handler params. */
export function defineMethod<
  Input extends ValidRpcParams = void,
  OutSchema extends StandardSchemaV1<any, any> | undefined = undefined,
  R = unknown,
>(
  options: {
    /** Omit input schema to type params directly on the handler. */
    readonly input?: undefined
    /** Optional Standard Schema v1 validator for the handler's success return value. */
    readonly output?: OutSchema
  },
  handler: (input: Input, ctx: RpcContext) => R
): MethodDef<
  Input,
  OutSchema extends StandardSchemaV1<any, any>
    ? InferSchemaOutput<OutSchema> | Extract<Awaited<R>, RpcErrorValue>
    : Awaited<R>
>

export function defineMethod(
  first:
    | ((input: any, ctx: RpcContext) => unknown)
    | StandardSchemaV1
    | MethodSchemaOptions,
  second?: (input: any, ctx: RpcContext) => unknown
): MethodDef {
  if (isStandardSchema(first)) {
    return {
      [METHOD_BRAND]: true,
      inputSchema: first,
      handler: second as (input: any, ctx: RpcContext) => unknown,
      hooks: [],
    }
  }

  if (typeof first === 'function') {
    return {
      [METHOD_BRAND]: true,
      handler: first,
      hooks: [],
    }
  }

  return {
    [METHOD_BRAND]: true,
    inputSchema: first.input,
    outputSchema: first.output,
    handler: second as (input: any, ctx: RpcContext) => unknown,
    hooks: [],
  }
}

/** Define an outbound JSON-RPC 2.0 Notification validated by a Standard Schema v1 schema. */
export function defineNotify<S extends StandardSchemaV1<ValidRpcParams, any>>(
  schema: S
): NotifyDef<InferSchemaInput<S>, InferSchemaOutput<S>>

/** Define a typed outbound JSON-RPC 2.0 Notification contract. */
export function defineNotify<Params extends ValidRpcParams = void>(): NotifyDef<
  Params,
  Params
>

export function defineNotify(schema?: StandardSchemaV1): NotifyDef {
  return schema ? { [NOTIFY_BRAND]: true, schema } : { [NOTIFY_BRAND]: true }
}
