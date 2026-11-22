import type { RpcErrorValue } from '../protocol/errors'
import type { Result, StandardRpcError } from '../protocol/types'
import type { MethodDef, NotifyDef } from '../service/method'
import type { ServiceTree } from '../service/service'
import type { ToClientError } from '../service/types'
import type { CallArgsWithOptions, KrpcClient } from './client'

/**
 * Deep recursive proxy type mirroring a `defineService` tree for property-style RPC calls
 * (e.g. `rpc.math.divide({ a: 10, b: 2 })`). Excludes outbound `defineNotify` entries.
 */
export type RpcProxy<S> = {
  readonly [
    K in keyof S & string as S[K] extends NotifyDef ? never : K
  ]: S[K] extends MethodDef<infer Input, infer RawReturn>
    ? (
        ...args: CallArgsWithOptions<Input>
      ) => Promise<
        Result<
          Exclude<RawReturn, RpcErrorValue>,
          ToClientError<Extract<RawReturn, RpcErrorValue>> | StandardRpcError
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
export function createProxy<App>(
  client: Pick<KrpcClient<App>, 'call' | '_app'>
): RpcProxy<App> {
  return buildProxyNode(
    client.call as (...args: unknown[]) => Promise<unknown>,
    ''
  ) as RpcProxy<App>
}
