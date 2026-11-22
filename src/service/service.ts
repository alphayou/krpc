import { isPlainObject } from '../protocol/guards'
import { runWithHookCollector, type ServiceHookLayer } from './hooks'
import {
  isMethodDef,
  isNotifyDef,
  type MethodDef,
  type NotifyDef,
} from './method'

/** Unique symbol identifying a service tree created by `defineService`. */
export const SERVICE_BRAND: unique symbol =
  /*#__PURE__*/ Symbol.for('krpc.service')

/** Recursive tree of RPC methods, outbound notifications, and nested sub-services. */
export interface ServiceTree {
  readonly [key: string]: MethodDef | NotifyDef | ServiceTree
}

/** Service definition returned by `defineService`. */
export type ServiceDef<T extends ServiceTree = ServiceTree> = T & {
  /** Non-enumerable brand marking a `defineService` container. */
  readonly [SERVICE_BRAND]: true
}

/** Runtime type guard for `ServiceDef` containers. */
export function isServiceDef(value: unknown): value is ServiceDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[SERVICE_BRAND] === true
  )
}

function hasHooks(layer: ServiceHookLayer): boolean {
  return (
    layer.before.length > 0 || layer.after.length > 0 || layer.error.length > 0
  )
}

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else {
    obj[key] = value
  }
}

function attachHooks(tree: ServiceTree, layer: ServiceHookLayer): ServiceTree {
  const attach = hasHooks(layer)
  const cloned: Record<string, MethodDef | NotifyDef | ServiceTree> = {}

  for (const [key, entry] of Object.entries(tree)) {
    if (isMethodDef(entry)) {
      setOwn(
        cloned,
        key,
        attach ? { ...entry, hooks: [layer, ...entry.hooks] } : { ...entry }
      )
    } else if (isNotifyDef(entry)) {
      setOwn(cloned, key, entry)
    } else if (isPlainObject(entry)) {
      setOwn(cloned, key, attachHooks(entry as ServiceTree, layer))
    }
  }

  Object.defineProperty(cloned, SERVICE_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  })

  return cloned as ServiceTree
}

/**
 * Define a composable RPC service module.
 * Executes `setup` synchronously once, collecting any `onBefore`, `onAfter`, and `onError`
 * hooks and attaching them immutably to every leaf method in the returned tree.
 */
export function defineService<T extends ServiceTree>(
  setup: () => T
): ServiceDef<T> {
  const { result, hooks } = runWithHookCollector(setup)

  if (
    result !== null &&
    typeof result === 'object' &&
    'then' in result &&
    typeof (result as unknown as PromiseLike<unknown>).then === 'function'
  ) {
    throw new Error('defineService() setup function must be synchronous')
  }

  return attachHooks(result, hooks) as ServiceDef<T>
}

/** Precompiled flat lookup tables produced by `compileService`. */
export interface CompiledService {
  /** Dot-separated method name to `MethodDef` lookup table. */
  readonly methods: ReadonlyMap<string, MethodDef>
  /** Dot-separated notification name to `NotifyDef` lookup table. */
  readonly notifiesByName: ReadonlyMap<string, NotifyDef>
  /** `NotifyDef` reference to dot-separated notification name lookup table. */
  readonly notifyNames: WeakMap<NotifyDef, string>
}

/** Flatten a nested service tree into O(1) runtime lookup maps. */
export function compileService(service: ServiceTree): CompiledService {
  const methods = new Map<string, MethodDef>()
  const notifiesByName = new Map<string, NotifyDef>()
  const notifyNames = new WeakMap<NotifyDef, string>()

  const walk = (node: ServiceTree, prefix: string) => {
    for (const [key, entry] of Object.entries(node)) {
      const name = prefix ? `${prefix}.${key}` : key
      if (isMethodDef(entry)) {
        methods.set(name, entry)
      } else if (isNotifyDef(entry)) {
        notifiesByName.set(name, entry)
        notifyNames.set(entry, name)
      } else if (isPlainObject(entry)) {
        walk(entry as ServiceTree, name)
      }
    }
  }

  walk(service, '')

  return { methods, notifiesByName, notifyNames }
}
