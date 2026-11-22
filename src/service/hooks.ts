import type { RpcErrorValue } from '../protocol/errors'
import type { RpcContext } from './context'

/** Hook executed before a method handler runs; returning an `RpcErrorValue` short-circuits execution. */
export type BeforeHook = (
  ctx: RpcContext
) => void | RpcErrorValue | Promise<void | RpcErrorValue>

/** Hook executed after a method handler succeeds. */
export type AfterHook = (
  result: unknown,
  ctx: RpcContext
) => void | Promise<void>

/** Hook executed when a method fails via returned error, validation error, or thrown exception. */
export type ErrorHook = (
  error: unknown,
  ctx: RpcContext
) => void | Promise<void>

/** Collected lifecycle hooks registered within a single `defineService` scope. */
export interface ServiceHookLayer {
  /** Hooks run before method execution. */
  readonly before: readonly BeforeHook[]
  /** Hooks run after successful method execution. */
  readonly after: readonly AfterHook[]
  /** Hooks run on method failure. */
  readonly error: readonly ErrorHook[]
}

interface MutableHookCollector {
  before: BeforeHook[]
  after: AfterHook[]
  error: ErrorHook[]
}

const collectorStack: MutableHookCollector[] = []

function activeCollector(name: string): MutableHookCollector {
  const frame = collectorStack[collectorStack.length - 1]
  if (!frame) {
    throw new Error(`${name}() can only be called inside defineService()`)
  }
  return frame
}

/** @internal Execute a synchronous service setup inside an isolated hook collection frame. */
export function runWithHookCollector<T>(setup: () => T): {
  readonly result: T
  readonly hooks: ServiceHookLayer
} {
  const frame: MutableHookCollector = { before: [], after: [], error: [] }
  collectorStack.push(frame)
  try {
    const result = setup()
    return { result, hooks: frame }
  } finally {
    collectorStack.pop()
  }
}

/** Register a hook that runs before every method in the current `defineService` scope. */
export function onBefore(hook: BeforeHook): void {
  activeCollector('onBefore').before.push(hook)
}

/** Register a hook that runs after every method in the current `defineService` scope succeeds. */
export function onAfter(hook: AfterHook): void {
  activeCollector('onAfter').after.push(hook)
}

/** Register a hook that runs when any method in the current `defineService` scope fails. */
export function onError(hook: ErrorHook): void {
  activeCollector('onError').error.push(hook)
}
