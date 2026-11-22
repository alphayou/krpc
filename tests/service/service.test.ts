import { describe, expect, it } from 'bun:test'
import { defineError, type RpcErrorValue } from '../../src/protocol/errors'
import { isPlainObject } from '../../src/protocol/guards'
import type { StandardSchemaV1 } from '../../src/protocol/standard-schema'
import type { StandardRpcError } from '../../src/protocol/types'
import { createRpcContext, defineContext } from '../../src/service/context'
import { onAfter, onBefore, onError } from '../../src/service/hooks'
import {
  defineMethod,
  defineNotify,
  isMethodDef,
  isNotifyDef,
} from '../../src/service/method'
import {
  compileService,
  defineService,
  isServiceDef,
} from '../../src/service/service'
import type {
  CallArgs,
  InferError,
  InferInput,
  InferNotify,
  InferOutput,
  MethodNames,
  NotifyNames,
} from '../../src/service/types'

const numericPairSchema: StandardSchemaV1<
  { a: number; b?: number },
  { a: number; b: number }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (!isPlainObject(value) || typeof value.a !== 'number') {
        return { issues: [{ message: 'Expected number', path: ['a'] }] }
      }
      return {
        value: {
          a: value.a,
          b: typeof value.b === 'number' ? value.b : 1,
        },
      }
    },
  },
}

const numberOnlySchema: StandardSchemaV1<number, number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      return typeof value === 'number'
        ? { value }
        : { issues: [{ message: 'Expected number' }] }
    },
  },
}

describe('defineContext and createRpcContext', () => {
  it('handles required and defaulted context tokens', () => {
    const User = defineContext<{ id: string }>()
    const Locale = defineContext('en-US')
    const OptionalFlag = defineContext<boolean | undefined>(undefined)

    const ctx = createRpcContext({
      method: 'user.get',
      id: 1,
      isNotification: false,
    })

    expect(ctx.method).toBe('user.get')
    expect(ctx.id).toBe(1)
    expect(ctx.isNotification).toBe(false)
    expect(ctx.canNotify).toBe(false)
    expect(ctx.signal.aborted).toBe(false)

    expect(ctx.get(User)).toBeUndefined()
    expect(ctx.has(User)).toBe(false)
    expect(() => ctx.require(User)).toThrow(
      'Required context token is missing for method "user.get"'
    )

    const defaultLocale: string = ctx.get(Locale)
    expect(defaultLocale).toBe('en-US')
    expect(ctx.has(Locale)).toBe(true)
    expect(ctx.require(Locale)).toBe('en-US')
    expect(ctx.has(OptionalFlag)).toBe(true)
    expect(ctx.require(OptionalFlag)).toBeUndefined()

    ctx.set(User, { id: 'u1' })
    ctx.set(Locale, 'ja-JP')

    expect(ctx.has(User)).toBe(true)
    expect(ctx.get(User)).toEqual({ id: 'u1' })
    expect(ctx.require(User)).toEqual({ id: 'u1' })
    expect(ctx.get(Locale)).toBe('ja-JP')
    expect(ctx.require(Locale)).toBe('ja-JP')
  })
})

describe('lifecycle hook registration', () => {
  it('throws clear errors when hooks are called outside defineService', () => {
    expect(() => onBefore(() => {})).toThrow(
      'onBefore() can only be called inside defineService()'
    )
    expect(() => onAfter(() => {})).toThrow(
      'onAfter() can only be called inside defineService()'
    )
    expect(() => onError(() => {})).toThrow(
      'onError() can only be called inside defineService()'
    )
  })

  it('rejects async defineService setup functions', () => {
    expect(() =>
      // @ts-expect-error async setup is disallowed
      defineService(async () => ({
        ping: defineMethod(() => 'pong'),
      }))
    ).toThrow('defineService() setup function must be synchronous')
  })

  it('cleans up collector stack if setup throws', () => {
    expect(() =>
      defineService(() => {
        onBefore(() => {})
        throw new Error('setup failed')
      })
    ).toThrow('setup failed')

    expect(() => onBefore(() => {})).toThrow(
      'onBefore() can only be called inside defineService()'
    )
  })
})

describe('defineService, spreading, nesting, and compileService', () => {
  const DivByZero = defineError(-32002, 'Division by zero')
  const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

  it('attaches hooks immutably across nesting, spreading, and inline sub-services', () => {
    const sharedPing = defineMethod(() => 'pong' as const)

    const user = defineService(() => {
      onBefore(() => {})
      const get = defineMethod(({ id }: { id: string }) => ({ id }))
      return { get }
    })

    const app = defineService(() => {
      onBefore(() => {})
      onAfter(() => {})

      const inline = defineService(() => {
        onError(() => {})
        const status = defineMethod(() => 'ok' as const)
        return { status }
      })

      const progress = defineNotify<{ percent: number }>()
      const start = defineMethod(() => true)

      return {
        ping: sharedPing,
        ...user,
        inline,
        progress,
        start,
      }
    })

    expect(isServiceDef(app)).toBe(true)
    expect(isServiceDef({})).toBe(false)
    expect(isMethodDef(sharedPing)).toBe(true)
    expect(isMethodDef(app.progress)).toBe(false)
    expect(isNotifyDef(app.progress)).toBe(true)
    expect(isNotifyDef(sharedPing)).toBe(false)

    // Original definitions must remain unmutated
    expect(sharedPing.hooks).toHaveLength(0)
    expect(user.get.hooks).toHaveLength(1)

    const compiled = compileService(app)
    expect([...compiled.methods.keys()].sort()).toEqual([
      'get',
      'inline.status',
      'ping',
      'start',
    ])
    expect(compiled.methods.get('ping')?.hooks).toHaveLength(1)
    expect(compiled.methods.get('get')?.hooks).toHaveLength(2)
    expect(compiled.methods.get('inline.status')?.hooks).toHaveLength(2)
    expect(compiled.notifiesByName.get('progress')).toBe(app.progress)
    expect(compiled.notifyNames.get(app.progress)).toBe('progress')
  })

  it('supports callable Standard Schema validators (e.g. ArkType) in defineMethod', () => {
    const callableSchema: ((v: unknown) => unknown) &
      StandardSchemaV1<{ x: number }, { x: number }> = Object.assign(
      (v: unknown) => v,
      {
        '~standard': {
          version: 1 as const,
          vendor: 'callable',
          validate(value: unknown) {
            if (isPlainObject(value) && typeof value.x === 'number') {
              return { value: { x: value.x } }
            }
            return { issues: [{ message: 'Expected { x: number }' }] }
          },
        },
      }
    )

    const handler = ({ x }: { x: number }) => x * 2
    const method = defineMethod(callableSchema, handler)
    expect(method.inputSchema).toBe(callableSchema)
    expect(method.handler).toBe(handler)
  })

  it('infers flattened method/notify names, inputs, outputs, errors, and call args', () => {
    interface Point {
      x: number
      y: number
    }

    const math = defineService(() => {
      const divide = defineMethod(numericPairSchema, ({ a, b }) => {
        if (b === 0) return DivByZero()
        if (a > 1e9) return Overflow({ max: 1e9 })
        return a / b
      })
      const sum = defineMethod(([a, b]: [number, number]) => a + b)
      const norm = defineMethod((p: Point) => Math.hypot(p.x, p.y))
      const opt = defineMethod((p?: { tag?: string }) => p?.tag ?? 'none')
      return { divide, sum, norm, opt }
    })

    const job = defineService(() => {
      const progress = defineNotify<{ jobId: string; percent: number }>()
      const tick = defineNotify()
      const start = defineMethod(async ({ jobId }: { jobId: string }) => ({
        started: jobId,
      }))
      return { progress, tick, start }
    })

    const app = defineService(() => {
      const ping = defineMethod(() => 'pong' as const)
      return { ping, math, job }
    })

    type App = typeof app
    type Methods = MethodNames<App>
    type Notifies = NotifyNames<App>

    const m1: Methods = 'ping'
    const m2: Methods = 'math.divide'
    const m3: Methods = 'math.sum'
    const m4: Methods = 'math.norm'
    const m5: Methods = 'math.opt'
    const m6: Methods = 'job.start'
    const n1: Notifies = 'job.progress'
    const n2: Notifies = 'job.tick'

    // Schema input keeps `b` optional while handler received required `b`
    const divideInput: InferInput<App, 'math.divide'> = { a: 10 }
    const divideOut: InferOutput<App, 'math.divide'> = 5
    const pingArgs: CallArgs<InferInput<App, 'ping'>> = []
    const optArgsEmpty: CallArgs<InferInput<App, 'math.opt'>> = []
    const optArgsSet: CallArgs<InferInput<App, 'math.opt'>> = [{ tag: 'v1' }]
    const progressPayload: InferNotify<App, 'job.progress'> = {
      jobId: '1',
      percent: 50,
    }

    type DivideErr = InferError<App, 'math.divide'>
    const overflowErr: DivideErr = {
      code: -32003,
      message: 'Overflow',
      data: { max: 1e9 },
    }
    const stdErr: DivideErr = {
      code: -32602,
      message: 'Invalid params',
    } satisfies StandardRpcError

    expect([
      m1,
      m2,
      m3,
      m4,
      m5,
      m6,
      n1,
      n2,
      divideInput,
      divideOut,
      pingArgs,
      optArgsEmpty,
      optArgsSet,
      progressPayload,
      overflowErr,
      stdErr,
    ]).toBeDefined()

    const _compileTimeAssertions = () => {
      // @ts-expect-error primitive number param is forbidden by JSON-RPC 2.0
      defineMethod((n: number) => n + 1)
      // @ts-expect-error primitive string param is forbidden by JSON-RPC 2.0
      defineMethod((s: string) => s.length)
      // @ts-expect-error primitive boolean param is forbidden by JSON-RPC 2.0
      defineMethod((b: boolean) => !b)
      // @ts-expect-error null param is forbidden by JSON-RPC 2.0
      defineMethod((x: null) => x)
      // @ts-expect-error primitive Standard Schema input is forbidden
      defineMethod(numberOnlySchema, (n) => n)
      // @ts-expect-error primitive notify payload is forbidden
      defineNotify<number>()
      // @ts-expect-error primitive notify schema is forbidden
      defineNotify(numberOnlySchema)
      // @ts-expect-error NotifyNames cannot appear in MethodNames
      const _badMethod: Methods = 'job.progress'
      // @ts-expect-error MethodNames cannot appear in NotifyNames
      const _badNotify: Notifies = 'ping'
      // @ts-expect-error RpcErrorValue must be excluded from InferOutput
      const _badOut: InferOutput<App, 'math.divide'> =
        DivByZero() satisfies RpcErrorValue
      void _badMethod
      void _badNotify
      void _badOut
    }
    expect(typeof _compileTimeAssertions).toBe('function')
  })
})
