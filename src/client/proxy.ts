import type { RpcErrorValue } from '../protocol/errors'
import type {
  JsonRpcErrorObject,
  JsonRpcParams,
  Result,
  StandardRpcError,
} from '../protocol/types'
import type {
  MethodDef,
  NormalizeRpcResult,
  NotifyDef,
} from '../service/method'
import type { ServiceTree } from '../service/service'
import type {
  IsUntypedService,
  ToClientError,
  UntypedService,
} from '../service/types'
import type { CallArgsWithOptions, CallOptions, KrpcClient } from './client'

/** Recursive callable proxy type returned by `createProxy` for an untyped `KrpcClient` or `KrpcPeer`. */
export interface UntypedRpcProxy {
  /** Invoke the dot-path method with optional structured `JsonRpcParams` and `CallOptions`. */
  (
    params?: JsonRpcParams,
    options?: CallOptions
  ): Promise<Result<unknown, JsonRpcErrorObject>>
  /** Access a nested namespace or method segment. */
  readonly [method: string]: UntypedRpcProxy
}

/**
 * Deep recursive proxy type mirroring a `defineService` tree for property-style RPC calls
 * (e.g. `rpc.math.divide({ a: 10, b: 2 })`). Excludes outbound `defineNotify` entries.
 */
export type RpcProxy<S> =
  IsUntypedService<S> extends true
    ? UntypedRpcProxy
    : {
        readonly [
          K in keyof S & string as S[K] extends NotifyDef ? never : K
        ]: S[K] extends MethodDef<infer Input, infer RawReturn>
          ? (
              ...args: CallArgsWithOptions<Input>
            ) => Promise<
              Result<
                NormalizeRpcResult<Exclude<RawReturn, RpcErrorValue>>,
                | ToClientError<Extract<RawReturn, RpcErrorValue>>
                | StandardRpcError
              >
            >
          : S[K] extends ServiceTree
            ? RpcProxy<S[K]>
            : never
      }

function buildProxyNode(
  call: (...args: unknown[]) => Promise<unknown>,
  path: string
): unknown {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') {
        return undefined
      }
      return buildProxyNode(call, path ? `${path}.${prop}` : prop)
    },
    apply(_target, _thisArg, argList) {
      return call(path, ...argList)
    },
  })
}

/**
 * Wrap a `KrpcClient` or `KrpcPeer` in a lightweight recursive `Proxy`
 * that mirrors the nested structure of the target `defineService` tree.
 */
export function createProxy<App = UntypedService>(
  client: Pick<KrpcClient<App>, 'call' | '_app'>
): RpcProxy<App> {
  return buildProxyNode(
    client.call as (...args: unknown[]) => Promise<unknown>,
    ''
  ) as RpcProxy<App>
}
