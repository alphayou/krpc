import { describe, expect, it } from 'bun:test'
import { createPeer } from '../../src/peer/peer'
import {
  defineError,
  JsonRpcError,
  serverError,
} from '../../src/protocol/errors'
import { isPlainObject, parseJsonRpcPayload } from '../../src/protocol/guards'
import type { StandardSchemaV1 } from '../../src/protocol/standard-schema'
import { JSON_RPC_ERROR_CODES } from '../../src/protocol/types'
import { createServer, type RpcServer } from '../../src/server/server'
import { createRpcContext, defineContext } from '../../src/service/context'
import { onAfter, onBefore, onError } from '../../src/service/hooks'
import { defineMethod, defineNotify } from '../../src/service/method'
import { compileService, defineService } from '../../src/service/service'
import { createHttpHandler } from '../../src/transports/http'
import { createMemoryDuplexPair } from '../../src/transports/memory'

const divideInputSchema: StandardSchemaV1<
  { a: number; b?: number },
  { a: number; b: number }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (!isPlainObject(value) || typeof value.a !== 'number') {
        return {
          issues: [{ message: 'a must be a number', path: [{ key: 'a' }] }],
        }
      }
      if (value.b !== undefined && typeof value.b !== 'number') {
        return {
          issues: [{ message: 'b must be a number', path: ['b'] }],
        }
      }
      return { value: { a: value.a, b: value.b ?? 1 } }
    },
  },
}

const asyncOutputSchema: StandardSchemaV1<{ ok: boolean }, { ok: boolean }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      if (isPlainObject(value) && typeof value.ok === 'boolean') {
        return { value: { ok: value.ok } }
      }
      return { issues: [{ message: 'Expected { ok: boolean }' }] }
    },
  },
}

describe('createServer — single requests and JSON-RPC 2.0 protocol rules', () => {
  const DivByZero = defineError(-32002, 'Division by zero')
  const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

  const app = defineService(() => {
    const ping = defineMethod(() => 'pong' as const)
    const noop = defineMethod(() => {})
    const sum = defineMethod(([a, b]: [number, number]) => a + b)
    const divide = defineMethod(divideInputSchema, ({ a, b }) => {
      if (b === 0) return DivByZero()
      if (a > 1000) return Overflow({ max: 1000 })
      return a / b
    })
    const checkedOut = defineMethod(
      { output: asyncOutputSchema },
      (params: { valid: boolean }) =>
        (params.valid ? { ok: true } : { ok: 'nope' }) as unknown as {
          ok: boolean
        }
    )
    const boom = defineMethod(() => {
      throw new Error('sensitive database password')
    })
    const throwRpc = defineMethod(() => {
      throw serverError(-32050, 'Service degraded', { region: 'us' })
    })

    return {
      ping,
      noop,
      math: { sum, divide },
      checkedOut,
      boom,
      throwRpc,
    }
  })

  const server = createServer(app)

  it('dispatches valid requests including id: null and void results', async () => {
    expect(
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'ping' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: 'pong',
    })

    expect(
      await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })
    ).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: 'pong',
    })

    expect(
      await server.handle({ jsonrpc: '2.0', id: 0, method: 'noop' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: null,
    })

    expect(
      await server.handle({ jsonrpc: '2.0', id: '', method: 'ping' })
    ).toEqual({
      jsonrpc: '2.0',
      id: '',
      result: 'pong',
    })

    // Preserves falsy valid IDs (0 and "") on Invalid Request errors and in batches
    expect(
      await server.handle([
        { jsonrpc: '2.0', id: 0, method: 'ping', params: 'bad' },
        { jsonrpc: '2.0', id: '', method: 'math.sum', params: [1, 2] },
      ])
    ).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid Request',
        },
      },
      { jsonrpc: '2.0', id: '', result: 3 },
    ])

    expect(
      await server.handleRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 's1',
          method: 'math.sum',
          params: [3, 4],
        })
      )
    ).toEqual({
      jsonrpc: '2.0',
      id: 's1',
      result: 7,
    })
  })

  it('handles parse errors, invalid requests, missing methods, and reserved rpc.* methods', async () => {
    expect(await server.handleRaw('{bad json')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
        message: 'Parse error',
      },
    })

    expect(await server.handleRaw('[]')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    })

    expect(await server.handleRaw('42')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    })

    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 5,
        method: 'ping',
        params: 'primitive-not-allowed',
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    })

    expect(
      await server.handle({ jsonrpc: '1.0', id: 5, method: 'ping' })
    ).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    })

    expect(
      await server.handle({ jsonrpc: '2.0', id: 6, method: 'does.not.exist' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: {
        code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
        message: 'Method not found',
      },
    })

    expect(
      await server.handle({ jsonrpc: '2.0', id: 7, method: 'rpc.discover' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
        message: 'Method not found',
      },
    })
  })

  it('allows reserved rpc.* methods when allowReservedMethods is enabled', async () => {
    const reservedApp = defineService(() => ({
      rpc: {
        discover: defineMethod(() => ['rpc.discover']),
      },
    }))
    const openServer = createServer(reservedApp, { allowReservedMethods: true })

    expect(
      await openServer.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'rpc.discover',
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: ['rpc.discover'],
    })
  })

  it('validates Standard Schema input/output and passes through domain & JsonRpc errors', async () => {
    // Default b = 1 applied by schema
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'math.divide',
        params: { a: 9 },
      })
    ).toEqual({ jsonrpc: '2.0', id: 1, result: 9 })

    // Input schema failure -> -32602 with compact issues
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'math.divide',
        params: { a: 'bad' },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        message: 'Invalid params',
        data: { issues: [{ message: 'a must be a number', path: ['a'] }] },
      },
    })

    // Returned domain errors
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'math.divide',
        params: { a: 10, b: 0 },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32002, message: 'Division by zero' },
    })

    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'math.divide',
        params: { a: 5000, b: 2 },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32003, message: 'Overflow', data: { max: 1000 } },
    })

    // Thrown JsonRpcError passes through
    expect(
      await server.handle({ jsonrpc: '2.0', id: 5, method: 'throwRpc' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: {
        code: -32050,
        message: 'Service degraded',
        data: { region: 'us' },
      },
    })

    // Output schema success and failure (masked as -32603)
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 6,
        method: 'checkedOut',
        params: { valid: true },
      })
    ).toEqual({ jsonrpc: '2.0', id: 6, result: { ok: true } })

    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 7,
        method: 'checkedOut',
        params: { valid: false },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    // Unexpected error is masked
    expect(
      await server.handle({ jsonrpc: '2.0', id: 8, method: 'boom' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 8,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })
  })

  it('supports custom formatError returning plain object or JsonRpcError', async () => {
    const customPlain = createServer(app, {
      formatError(err, ctx) {
        return {
          code: -32603,
          message: `Failed in ${ctx.method}: ${String((err as Error).message)}`,
        }
      },
    })

    expect(
      await customPlain.handle({ jsonrpc: '2.0', id: 1, method: 'boom' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32603,
        message: 'Failed in boom: sensitive database password',
      },
    })

    const customClass = createServer(app, {
      formatError() {
        return new JsonRpcError(-32099, 'Mapped error', { masked: true })
      },
    })

    expect(
      await customClass.handle({ jsonrpc: '2.0', id: 2, method: 'boom' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32099, message: 'Mapped error', data: { masked: true } },
    })
  })
})

describe('createServer — notifications, hooks, context, and ctx.notify', () => {
  const AuthHeader = defineContext<string>()
  const CurrentUser = defineContext<{ name: string }>()
  const Unauthorized = defineError(-32001, 'Unauthorized')

  it('runs hooks in outer->inner before, inner->outer after, and inner->outer error order', async () => {
    const trace: string[] = []

    function useAuth() {
      onBefore((ctx) => {
        trace.push('auth.before')
        const token = ctx.get(AuthHeader)
        if (token !== 'secret') return Unauthorized()
        ctx.set(CurrentUser, { name: 'Alice' })
      })
    }

    const inner = defineService(() => {
      useAuth()
      onAfter((res) => {
        trace.push(`inner.after:${JSON.stringify(res)}`)
      })
      onError((err) => {
        trace.push(`inner.error:${(err as { code?: number }).code ?? 'err'}`)
      })

      const greet = defineMethod((_, ctx) => {
        trace.push('handler')
        return `Hello, ${ctx.require(CurrentUser).name}`
      })
      return { greet }
    })

    const root = defineService(() => {
      onBefore(() => {
        trace.push('root.before')
      })
      onAfter(() => {
        trace.push('root.after')
      })
      onError(() => {
        trace.push('root.error')
        throw new Error('observer failure must not break response')
      })
      return { inner }
    })

    const server = createServer(root)

    // Authorized request
    const okRes = await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'inner.greet' },
      {
        setupContext(ctx) {
          ctx.set(AuthHeader, 'secret')
        },
      }
    )
    expect(okRes).toEqual({ jsonrpc: '2.0', id: 1, result: 'Hello, Alice' })
    expect(trace).toEqual([
      'root.before',
      'auth.before',
      'handler',
      'inner.after:"Hello, Alice"',
      'root.after',
    ])

    // Short-circuited by onBefore returning RpcErrorValue
    trace.length = 0
    const errRes = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'inner.greet',
    })
    expect(errRes).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32001, message: 'Unauthorized' },
    })
    expect(trace).toEqual([
      'root.before',
      'auth.before',
      'inner.error:-32001',
      'root.error',
    ])
  })

  it('awaits Notifications without ever returning a response, even on errors', async () => {
    let completed = false
    const observedErrors: unknown[] = []

    const app = defineService(() => {
      onError((err, ctx) => {
        observedErrors.push({
          method: ctx.method,
          isNotification: ctx.isNotification,
          err,
        })
      })

      const slowLog = defineMethod(async ({ msg }: { msg: string }, ctx) => {
        expect(ctx.isNotification).toBe(true)
        expect(ctx.id).toBeUndefined()
        await new Promise((r) => setTimeout(r, 15))
        completed = msg === 'done'
      })

      const failNotif = defineMethod(() => {
        throw new Error('notif crash')
      })

      const schemaNotif = defineMethod(divideInputSchema, () => 'ok')
      const domainErrNotif = defineMethod(() => Unauthorized())
      const guarded = defineService(() => {
        onBefore(() => Unauthorized())
        return { blocked: defineMethod(() => 'never') }
      })

      return { slowLog, failNotif, schemaNotif, domainErrNotif, guarded }
    })

    const server = createServer(app)

    const res = await server.handle({
      jsonrpc: '2.0',
      method: 'slowLog',
      params: { msg: 'done' },
    })
    expect(res).toBeUndefined()
    expect(completed).toBe(true)

    expect(
      await server.handle({ jsonrpc: '2.0', method: 'failNotif' })
    ).toBeUndefined()
    expect(
      await server.handle({
        jsonrpc: '2.0',
        method: 'schemaNotif',
        params: { a: 'bad' },
      })
    ).toBeUndefined()
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'domainErrNotif' })
    ).toBeUndefined()
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'guarded.blocked' })
    ).toBeUndefined()
    expect(observedErrors).toHaveLength(4)

    expect(
      await server.handle({ jsonrpc: '2.0', method: 'missing' })
    ).toBeUndefined()
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'rpc.internal' })
    ).toBeUndefined()
  })

  it('resolves and validates outbound ctx.notify() and forwards AbortSignal', async () => {
    const progressSchema: StandardSchemaV1<
      { jobId: string; percent: number },
      { jobId: string; percent: number }
    > = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
          if (
            isPlainObject(value) &&
            typeof value.jobId === 'string' &&
            typeof value.percent === 'number'
          ) {
            return { value: { jobId: value.jobId, percent: value.percent } }
          }
          return { issues: [{ message: 'Invalid progress payload' }] }
        },
      },
    }

    const unregistered = defineNotify<{ x: number }>()

    const job = defineService(() => {
      const progress = defineNotify(progressSchema)
      const done = defineNotify<{ jobId: string }>()

      const run = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
        if (!ctx.canNotify)
          return { pushed: false, aborted: ctx.signal.aborted }
        await ctx.notify(progress, { jobId, percent: 50 })
        await ctx.notify(done, { jobId })
        return { pushed: true, aborted: ctx.signal.aborted }
      })

      const pushInvalid = defineMethod(async (_, ctx) => {
        await ctx.notify(progress, { jobId: '1', percent: 'bad' as never })
      })

      const pushUnregistered = defineMethod(async (_, ctx) => {
        await ctx.notify(unregistered, { x: 1 })
      })

      return { progress, done, run, pushInvalid, pushUnregistered }
    })

    const app = defineService(() => ({ job }))
    const server = createServer(app)

    expect(server.resolveNotify(job.progress)?.name).toBe('job.progress')
    expect(server.resolveNotify('job.progress')?.def).toBe(job.progress)
    expect(server.resolveNotify('unknown.notify')).toBeUndefined()

    // Without emitNotify: canNotify is false
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'job.run',
        params: { jobId: 'j1' },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { pushed: false, aborted: false },
    })

    // With emitNotify and AbortSignal
    const emitted: Array<{ method: string; params: unknown }> = []
    const ac = new AbortController()
    ac.abort()

    expect(
      await server.handle(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'job.run',
          params: { jobId: 'j2' },
        },
        {
          signal: ac.signal,
          emitNotify(method, params) {
            emitted.push({ method, params })
          },
        }
      )
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { pushed: true, aborted: true },
    })

    expect(emitted).toEqual([
      { method: 'job.progress', params: { jobId: 'j2', percent: 50 } },
      { method: 'job.done', params: { jobId: 'j2' } },
    ])

    // Invalid outbound notify schema payload is a server bug -> sanitized -32603
    const badNotifyRes = await server.handle(
      { jsonrpc: '2.0', id: 3, method: 'job.pushInvalid' },
      { emitNotify() {} }
    )
    expect(badNotifyRes).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    // Unregistered NotifyDef fails cleanly as -32603
    expect(
      await server.handle(
        { jsonrpc: '2.0', id: 4, method: 'job.pushUnregistered' },
        { emitNotify() {} }
      )
    ).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    // Calling ctx.notify with a registered NotifyDef when transport has no emitNotify silently drops and returns false
    const silentDropApp = defineService(() => {
      const done = defineNotify<{ jobId: string }>()
      const ping = defineNotify()
      const trigger = defineMethod(async (_, ctx) => {
        const sent1 = await ctx.notify(done, { jobId: 'j0' })
        const sent2 = await ctx.notify(ping)
        return {
          canNotify: ctx.canNotify,
          clientId: ctx.clientId ?? null,
          sent1,
          sent2,
        }
      })
      return { done, ping, trigger }
    })
    const silentServer = createServer(silentDropApp)
    expect(
      await silentServer.handle({ jsonrpc: '2.0', id: 5, method: 'trigger' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { canNotify: false, clientId: null, sent1: false, sent2: false },
    })

    // Unregistered NotifyDef and invalid schema STILL fail cleanly as -32603 even without emitNotify
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 6,
        method: 'job.pushUnregistered',
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 7,
        method: 'job.pushInvalid',
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    // emitNotify returning false or throwing transport error silently drops and returns false
    const dropResults: boolean[] = []
    const dropApp = defineService(() => {
      const note = defineNotify<{ n: number }>()
      const run = defineMethod(async (_, ctx) => {
        dropResults.push(await ctx.notify(note, { n: 1 }))
        return 'ok'
      })
      return { note, run }
    })
    const dropServer = createServer(dropApp)
    expect(
      await dropServer.handle(
        { jsonrpc: '2.0', id: 1, method: 'run' },
        { emitNotify: () => false }
      )
    ).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' })
    expect(
      await dropServer.handle(
        { jsonrpc: '2.0', id: 2, method: 'run' },
        {
          emitNotify() {
            throw new Error('socket closed')
          },
        }
      )
    ).toEqual({ jsonrpc: '2.0', id: 2, result: 'ok' })
    expect(dropResults).toEqual([false, false])
  })
})

describe('createServer — batch execution, maxBatchSize, and concurrency', () => {
  it('handles empty batch, maxBatchSize, mixed valid/invalid/notification items, and all-notification batch', async () => {
    const noted: number[] = []
    const app = defineService(() => ({
      double: defineMethod(({ n }: { n: number }) => n * 2),
      note: defineMethod(({ n }: { n: number }) => {
        noted.push(n)
      }),
    }))

    const server = createServer(app, { maxBatchSize: 5 })

    expect(await server.handle([])).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request',
      },
    })

    const oversized = Array.from({ length: 6 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'double',
      params: { n: i },
    }))
    expect(await server.handle(oversized)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Batch size exceeds maximum of 5',
      },
    })

    // Mixed batch: valid requests, notification, and malformed item
    const mixed = await server.handle([
      { jsonrpc: '2.0', id: 1, method: 'double', params: { n: 2 } },
      { jsonrpc: '2.0', method: 'note', params: { n: 99 } },
      123,
      { jsonrpc: '2.0', id: 2, method: 'double', params: { n: 5 } },
    ])
    expect(mixed).toEqual([
      { jsonrpc: '2.0', id: 1, result: 4 },
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid Request',
        },
      },
      { jsonrpc: '2.0', id: 2, result: 10 },
    ])
    expect(noted).toEqual([99])

    // All-notification batch returns undefined
    const allNotifs = await server.handle([
      { jsonrpc: '2.0', method: 'note', params: { n: 1 } },
      { jsonrpc: '2.0', method: 'note', params: { n: 2 } },
    ])
    expect(allNotifs).toBeUndefined()
    expect(noted).toEqual([99, 1, 2])
  })

  it('enforces batchConcurrency limits (sequential and bounded parallel)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const order: number[] = []

    const app = defineService(() => ({
      work: defineMethod(async ({ id, ms }: { id: number; ms: number }) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, ms))
        order.push(id)
        inFlight--
        return id
      }),
    }))

    // Sequential: batchConcurrency = 1
    const seqServer = createServer(app, { batchConcurrency: 1 })
    const seqRes = await seqServer.handle([
      { jsonrpc: '2.0', id: 1, method: 'work', params: { id: 1, ms: 20 } },
      { jsonrpc: '2.0', id: 2, method: 'work', params: { id: 2, ms: 5 } },
      { jsonrpc: '2.0', id: 3, method: 'work', params: { id: 3, ms: 5 } },
    ])
    expect(maxInFlight).toBe(1)
    expect(order).toEqual([1, 2, 3])
    expect(seqRes).toEqual([
      { jsonrpc: '2.0', id: 1, result: 1 },
      { jsonrpc: '2.0', id: 2, result: 2 },
      { jsonrpc: '2.0', id: 3, result: 3 },
    ])

    // Bounded concurrency = 2
    maxInFlight = 0
    order.length = 0
    const boundedServer = createServer(app, { batchConcurrency: 2 })
    const boundedRes = await boundedServer.handle([
      { jsonrpc: '2.0', id: 1, method: 'work', params: { id: 1, ms: 20 } },
      { jsonrpc: '2.0', id: 2, method: 'work', params: { id: 2, ms: 20 } },
      { jsonrpc: '2.0', id: 3, method: 'work', params: { id: 3, ms: 20 } },
      { jsonrpc: '2.0', id: 4, method: 'work', params: { id: 4, ms: 20 } },
    ])
    expect(maxInFlight).toBe(2)
    expect(boundedRes).toEqual([
      { jsonrpc: '2.0', id: 1, result: 1 },
      { jsonrpc: '2.0', id: 2, result: 2 },
      { jsonrpc: '2.0', id: 3, result: 3 },
      { jsonrpc: '2.0', id: 4, result: 4 },
    ])
  })
})

describe('createServer — wire normalization and unserializable result safety', () => {
  it('normalizes undefined, function, symbol, and toJSON()->undefined results to null', async () => {
    const app = defineService(() => ({
      undef: defineMethod(() => undefined),
      fn: defineMethod(() => (() => {}) as unknown),
      sym: defineMethod(() => Symbol('x') as unknown),
      toJsonUndef: defineMethod(() => ({
        toJSON() {
          return undefined
        },
      })),
    }))

    const server = createServer(app)

    for (const method of ['undef', 'fn', 'sym', 'toJsonUndef']) {
      const res = await server.handleRaw(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method })
      )
      expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: null })
      expect(JSON.stringify(res)).toBe('{"jsonrpc":"2.0","id":1,"result":null}')
    }
  })

  it('catches BigInt, circular objects, and throwing toJSON with onError and -32603 (single & batch)', async () => {
    const errors: Array<{ method: string; err: unknown }> = []
    const afters: string[] = []
    const BadDataErr = defineError(-32010, 'Bad data').data<unknown>()

    const app = defineService(() => {
      onError((err, ctx) => {
        errors.push({ method: ctx.method, err })
      })
      onAfter((_res, ctx) => {
        afters.push(ctx.method)
      })

      return {
        ok: defineMethod(() => 'fine'),
        bigIntTop: defineMethod(() => 42n as unknown),
        bigIntNested: defineMethod(() => ({ count: 42n }) as unknown),
        circular: defineMethod(() => {
          const obj: Record<string, unknown> = {}
          obj.self = obj
          return obj
        }),
        throwingToJson: defineMethod(() => ({
          toJSON() {
            throw new Error('toJSON failed')
          },
        })),
        badErrDataBigInt: defineMethod(() => BadDataErr(1n)),
        badErrDataCircular: defineMethod(() => {
          const obj: Record<string, unknown> = {}
          obj.self = obj
          return BadDataErr(obj)
        }),
      }
    })

    const server = createServer(app)

    for (const method of [
      'bigIntTop',
      'bigIntNested',
      'circular',
      'throwingToJson',
    ]) {
      const res = await server.handleRaw(
        JSON.stringify({ jsonrpc: '2.0', id: method, method })
      )
      expect(res).toEqual({
        jsonrpc: '2.0',
        id: method,
        error: {
          code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          message: 'Internal error',
        },
      })
    }

    expect(errors.map((e) => e.method)).toEqual([
      'bigIntTop',
      'bigIntNested',
      'circular',
      'throwingToJson',
    ])
    expect(afters).toEqual([])

    // Unserializable error data falls back cleanly to -32603
    expect(
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'badErrDataBigInt' })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'badErrDataCircular',
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    // Notification returning BigInt still produces no response
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'bigIntTop' })
    ).toBeUndefined()

    // Batch with valid + unserializable items preserves valid item and sanitizes bad items
    const batchRes = await server.handleRaw(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ok' },
        { jsonrpc: '2.0', id: 2, method: 'bigIntNested' },
        { jsonrpc: '2.0', id: 3, method: 'circular' },
      ])
    )
    expect(batchRes).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'fine' },
      {
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          message: 'Internal error',
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        error: {
          code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          message: 'Internal error',
        },
      },
    ])

    // Throwing formatError is caught and sanitized to -32603
    const badFormatterServer = createServer(
      defineService(() => ({
        boom: defineMethod(() => {
          throw new Error('fail')
        }),
      })),
      {
        formatError() {
          throw new Error('formatter crashed')
        },
      }
    )
    expect(
      await badFormatterServer.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'boom',
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })
  })

  it('safely serializes unserializable responses in createHttpHandler and createPeer even with custom RpcServer', async () => {
    const rawServer: RpcServer = {
      service: {},
      async handle(payload) {
        if (Array.isArray(payload)) {
          return [
            {
              jsonrpc: '2.0',
              id: (payload[0] as { id: number }).id,
              result: 'ok',
            },
            {
              jsonrpc: '2.0',
              id: (payload[1] as { id: number }).id,
              result: 99n,
            },
          ]
        }
        return {
          jsonrpc: '2.0',
          id: (payload as { id: number }).id,
          result: 99n,
        }
      },
      async handleRaw(text) {
        return this.handle(JSON.parse(text))
      },
      resolveNotify() {
        return undefined
      },
      connect() {
        throw new Error('not implemented')
      },
      async notify() {
        return false
      },
    }

    // HTTP single & batch must never throw on unserializable response
    const handler = createHttpHandler(rawServer)
    const singleHttp = await handler(
      new Request('https://rpc.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' }),
      })
    )
    expect(singleHttp.status).toBe(200)
    expect(await singleHttp.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    const batchHttp = await handler(
      new Request('https://rpc.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'good' },
          { jsonrpc: '2.0', id: 2, method: 'bad' },
        ]),
      })
    )
    expect(batchHttp.status).toBe(200)
    expect(await batchHttp.json()).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'ok' },
      {
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          message: 'Internal error',
        },
      },
    ])

    // Peer must never silently drop an unserializable response
    const [tServer, tClient] = createMemoryDuplexPair()
    const serverPeer = createPeer(tServer, rawServer)
    const clientPeer = createPeer(tClient)

    expect(await clientPeer.call('x')).toEqual({
      ok: false,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    const [b0, b1] = await clientPeer.batch((b) => [
      b.call('good'),
      b.call('bad'),
    ])
    expect(b0).toEqual({ ok: true, value: 'ok' })
    expect(b1).toEqual({
      ok: false,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })

    await clientPeer.close()
    await serverPeer.close()
  })
})

describe('createServer — ctx.after() early reply', () => {
  it('returns response immediately, runs tasks in order, catches errors via onError, and supports waitUntil & batches', async () => {
    const timeline: string[] = []
    const caughtErrors: Array<{ method: string; message: string }> = []
    const BadInput = defineError(-32001, 'Bad input')

    const app = defineService(() => {
      onError((err, ctx) => {
        caughtErrors.push({
          method: ctx.method,
          message: err instanceof Error ? err.message : String(err),
        })
      })

      const start = defineMethod(async ({ id }: { id: string }, ctx) => {
        ctx.after(async () => {
          timeline.push(`after1-start:${id}`)
          await new Promise((r) => setTimeout(r, 25))
          timeline.push(`after1-end:${id}`)
          ctx.after(() => {
            timeline.push(`after-nested:${id}`)
          })
        })
        ctx.after(() => {
          timeline.push(`after2:${id}`)
        })
        timeline.push(`reply:${id}`)
        return { accepted: id }
      })

      const failingAfter = defineMethod((_, ctx) => {
        ctx.after(() => {
          throw new Error('sync-after-boom')
        })
        ctx.after(async () => {
          throw new Error('async-after-boom')
        })
        ctx.after(() => {
          timeline.push('after-survived')
        })
        return 'ok'
      })

      const failEarly = defineMethod((_, ctx) => {
        ctx.after(() => {
          timeline.push('should-not-run')
        })
        return BadInput()
      })

      const noAfter = defineMethod(() => 'fast')

      return { start, failingAfter, failEarly, noAfter }
    })

    const server = createServer(app)

    // 1. Response arrives before slow ctx.after finishes, and waitUntil receives the background promise
    const bgPromises: Promise<void>[] = []
    const res = await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'start', params: { id: 'j1' } },
      { waitUntil: (p) => bgPromises.push(p) }
    )
    expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: { accepted: 'j1' } })
    expect(timeline).not.toContain('after1-end:j1')
    expect(bgPromises).toHaveLength(1)

    await Promise.all(bgPromises)
    expect(timeline).toEqual([
      'reply:j1',
      'after1-start:j1',
      'after1-end:j1',
      'after2:j1',
      'after-nested:j1',
    ])

    // 2. waitUntil is NOT called when ctx.after is never registered
    bgPromises.length = 0
    expect(
      await server.handle(
        { jsonrpc: '2.0', id: 2, method: 'noAfter' },
        { waitUntil: (p) => bgPromises.push(p) }
      )
    ).toEqual({ jsonrpc: '2.0', id: 2, result: 'fast' })
    expect(bgPromises).toHaveLength(0)

    // 3. Domain error short-circuits without running ctx.after
    timeline.length = 0
    expect(
      await server.handle(
        { jsonrpc: '2.0', id: 3, method: 'failEarly' },
        { waitUntil: (p) => bgPromises.push(p) }
      )
    ).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32001, message: 'Bad input' },
    })
    expect(bgPromises).toHaveLength(0)
    expect(timeline).toEqual([])

    // 4. Sync & async errors inside ctx.after are caught and forwarded to onError without rejecting
    caughtErrors.length = 0
    expect(
      await server.handle(
        { jsonrpc: '2.0', id: 4, method: 'failingAfter' },
        { waitUntil: (p) => bgPromises.push(p) }
      )
    ).toEqual({ jsonrpc: '2.0', id: 4, result: 'ok' })
    await Promise.all(bgPromises)
    expect(caughtErrors).toEqual([
      { method: 'failingAfter', message: 'sync-after-boom' },
      { method: 'failingAfter', message: 'async-after-boom' },
    ])
    expect(timeline).toEqual(['after-survived'])

    // 5. Works for JSON-RPC Notifications (returns undefined, still executes ctx.after)
    timeline.length = 0
    bgPromises.length = 0
    expect(
      await server.handle(
        { jsonrpc: '2.0', method: 'start', params: { id: 'notif' } },
        { waitUntil: (p) => bgPromises.push(p) }
      )
    ).toBeUndefined()
    await Promise.all(bgPromises)
    expect(timeline).toContain('after1-end:notif')
    expect(timeline).toContain('after2:notif')

    // 6. Works cleanly for batches with deferred onAfterTasks
    timeline.length = 0
    let deferredFlush: (() => Promise<void>) | undefined
    const batchRes = await server.handle(
      [
        { jsonrpc: '2.0', id: 10, method: 'start', params: { id: 'b1' } },
        { jsonrpc: '2.0', id: 11, method: 'noAfter' },
        { jsonrpc: '2.0', id: 12, method: 'start', params: { id: 'b2' } },
      ],
      {
        onAfterTasks(flush) {
          deferredFlush = flush
        },
      }
    )
    expect(batchRes).toEqual([
      { jsonrpc: '2.0', id: 10, result: { accepted: 'b1' } },
      { jsonrpc: '2.0', id: 11, result: 'fast' },
      { jsonrpc: '2.0', id: 12, result: { accepted: 'b2' } },
    ])
    // Strictly nothing from ctx.after has started yet before deferredFlush() is called!
    expect(timeline).toEqual(['reply:b1', 'reply:b2'])
    expect(deferredFlush).toBeDefined()
    await deferredFlush!()
    expect(timeline).toContain('after1-end:b1')
    expect(timeline).toContain('after1-end:b2')
  })
})

describe('createServer — server.connect(), server.notify(), and targeted ctx.notify()', () => {
  it('supports auto-generated IDs, multi-tab same id, auto-cleanup, targeted ctx.notify, and ordered ctx.after', async () => {
    const TagCtx = defineContext('none')
    const progressSchema: StandardSchemaV1<
      { jobId: string; percent: number },
      { jobId: string; percent: number }
    > = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
          if (
            isPlainObject(value) &&
            typeof value.jobId === 'string' &&
            typeof value.percent === 'number'
          ) {
            return { value: { jobId: value.jobId, percent: value.percent } }
          }
          return { issues: [{ message: 'invalid progress' }] }
        },
      },
    }

    const job = defineService(() => {
      const progress = defineNotify(progressSchema)
      const done = defineNotify<{ jobId: string }>()
      const ping = defineNotify()

      const whoami = defineMethod((_, ctx) => ({
        clientId: ctx.clientId ?? null,
        canNotify: ctx.canNotify,
        tag: ctx.get(TagCtx),
      }))

      const startEarly = defineMethod(({ jobId }: { jobId: string }, ctx) => {
        ctx.after(async () => {
          await ctx.notify(done, { jobId })
        })
        return { accepted: jobId }
      })

      const notifyUser = defineMethod(
        async (
          { targetId, jobId }: { targetId: string; jobId: string },
          ctx
        ) => {
          const sentDone = await ctx.notify(done, { jobId }, targetId)
          const sentPing = await ctx.notify(ping, undefined, targetId)
          return { sentDone, sentPing }
        }
      )

      return { progress, done, ping, whoami, startEarly, notifyUser }
    })

    const app = defineService(() => ({ job }))
    const server = createServer(app)

    // Before any connect(), server.notify silently drops and returns false (never throws)
    expect(await server.notify('ghost', 'job.done', { jobId: 'x' })).toBe(false)
    expect(await server.notify('ghost', job.ping)).toBe(false)

    // Schema & unregistered NotifyDef validation still throw even when target id is offline
    await expect(
      server.notify('ghost', 'job.progress', {
        jobId: 'x',
        percent: 'bad' as never,
      })
    ).rejects.toThrow('Invalid outbound notification params')
    const unregistered = defineNotify<{ x: number }>()
    await expect(
      server.notify('ghost', unregistered, { x: 1 })
    ).rejects.toThrow('Notification definition is not registered')

    // 1. Shorthand string id + multi-tab same id ('alice' has tab1 & tab2)
    const [tAlice1Srv, tAlice1Cli] = createMemoryDuplexPair()
    const [tAlice2Srv, tAlice2Cli] = createMemoryDuplexPair()
    const connAlice1 = server.connect(tAlice1Srv, 'alice')
    const connAlice2 = server.connect(tAlice2Srv, {
      id: 'alice',
      setupContext(ctx) {
        ctx.set(TagCtx, 'tab-2')
      },
    })
    expect(connAlice1.id).toBe('alice')
    expect(connAlice2.id).toBe('alice')

    const alice1Client = createPeer<typeof app>(tAlice1Cli)
    const alice2Client = createPeer<typeof app>(tAlice2Cli)

    expect(await alice1Client.call('job.whoami')).toEqual({
      ok: true,
      value: { clientId: 'alice', canNotify: true, tag: 'none' },
    })
    expect(await alice2Client.call('job.whoami')).toEqual({
      ok: true,
      value: { clientId: 'alice', canNotify: true, tag: 'tab-2' },
    })

    const tab1Done: string[] = []
    const tab2Done: string[] = []
    const tab1Pings: number[] = []
    const tab2Pings: number[] = []
    alice1Client.on('job.done', ({ jobId }) => {
      tab1Done.push(jobId)
    })
    alice2Client.on('job.done', ({ jobId }) => {
      tab2Done.push(jobId)
    })
    alice1Client.on('job.ping', () => {
      tab1Pings.push(1)
    })
    alice2Client.on('job.ping', () => {
      tab2Pings.push(1)
    })

    // server.notify delivers to ALL tabs registered under 'alice'
    expect(
      await server.notify('alice', 'job.done', { jobId: 'all-tabs' })
    ).toBe(true)
    expect(await server.notify('alice', job.ping)).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(tab1Done).toEqual(['all-tabs'])
    expect(tab2Done).toEqual(['all-tabs'])
    expect(tab1Pings).toHaveLength(1)
    expect(tab2Pings).toHaveLength(1)

    // conn.notify targets ONLY that specific tab
    expect(await connAlice1.notify(job.done, { jobId: 'tab1-only' })).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(tab1Done).toEqual(['all-tabs', 'tab1-only'])
    expect(tab2Done).toEqual(['all-tabs'])

    // Stateless server.handle (e.g. HTTP) AND duplex client targeting 'alice' via ctx.notify(def, params, targetId)
    expect(
      await alice1Client.call('job.notifyUser', {
        targetId: 'alice',
        jobId: 'from-duplex',
      })
    ).toEqual({
      ok: true,
      value: { sentDone: true, sentPing: true },
    })
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'job.notifyUser',
        params: { targetId: 'alice', jobId: 'from-http' },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { sentDone: true, sentPing: true },
    })
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'job.notifyUser',
        params: { targetId: 'offline', jobId: 'nope' },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { sentDone: false, sentPing: false },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(tab1Done).toContain('from-duplex')
    expect(tab2Done).toContain('from-duplex')
    expect(tab1Done).toContain('from-http')
    expect(tab2Done).toContain('from-http')

    // Closing tab 1 removes only tab 1; tab 2 continues receiving notifications
    await connAlice1.close()
    expect(await connAlice1.notify(job.done, { jobId: 'after-close' })).toBe(
      false
    )
    expect(
      await server.notify('alice', job.done, { jobId: 'tab2-still-up' })
    ).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(tab1Done).not.toContain('tab2-still-up')
    expect(tab2Done).toContain('tab2-still-up')

    // Closing tab 2 from client side auto-cleans 'alice' from registry
    await alice2Client.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(await server.notify('alice', job.done, { jobId: 'gone' })).toBe(
      false
    )

    // 2. Auto-generated IDs skip colliding user-supplied IDs ('c1') and are visible on ctx.clientId
    const [tC1Srv, tC1Cli] = createMemoryDuplexPair()
    const [tAutoSrv, tAutoCli] = createMemoryDuplexPair()
    const manualC1 = server.connect(tC1Srv, 'c1')
    const autoConn = server.connect(tAutoSrv)
    expect(manualC1.id).toBe('c1')
    expect(autoConn.id).toBe('c2')

    const autoClient = createPeer<typeof app>(tAutoCli)
    expect(await autoClient.call('job.whoami')).toEqual({
      ok: true,
      value: { clientId: 'c2', canNotify: true, tag: 'none' },
    })

    // 3. ctx.after() on server.connect strictly delivers call response BEFORE ctx.notify
    const order: string[] = []
    autoClient.on('job.done', ({ jobId }) => {
      order.push(`notify:${jobId}`)
    })
    const earlyRes = await autoClient.call('job.startEarly', {
      jobId: 'ordered-1',
    })
    order.push(`response:${earlyRes.ok ? earlyRes.value.accepted : 'err'}`)
    await new Promise((r) => setTimeout(r, 15))
    expect(order).toEqual(['response:ordered-1', 'notify:ordered-1'])

    // Same strict ordering for batches!
    order.length = 0
    const [b0, b1] = await autoClient.batch((b) => [
      b.call('job.startEarly', { jobId: 'batch-1' }),
      b.call('job.startEarly', { jobId: 'batch-2' }),
    ])
    order.push(
      `batch:${b0.ok ? b0.value.accepted : 'err'},${b1.ok ? b1.value.accepted : 'err'}`
    )
    await new Promise((r) => setTimeout(r, 15))
    expect(order[0]).toBe('batch:batch-1,batch-2')
    expect(order).toContain('notify:batch-1')
    expect(order).toContain('notify:batch-2')

    await autoConn.close()
    await manualC1.close()
    await tC1Cli.close()

    // 4. Synchronous onClose (already-closed transport) cleans up cleanly without leaking
    const closedTransport = {
      send() {
        throw new Error('closed')
      },
      onMessage() {
        return () => {}
      },
      onClose(h: () => void) {
        h()
        return () => {}
      },
      close() {},
    }
    const deadConn = server.connect(closedTransport, 'already-dead')
    expect(await server.notify('already-dead', job.ping)).toBe(false)
    expect(await deadConn.notify(job.ping)).toBe(false)

    // 5. Failing transport.send on an active server.connect silently returns false (never throws)
    const failingSendTransport = {
      send() {
        throw new Error('broken pipe')
      },
      onMessage() {
        return () => {}
      },
      onClose() {
        return () => {}
      },
      close() {},
    }
    const brokenConn = server.connect(failingSendTransport, 'broken-pipe')
    expect(await server.notify('broken-pipe', job.ping)).toBe(false)
    expect(await brokenConn.notify(job.ping)).toBe(false)
    await brokenConn.close()

    // 6. Standalone createRpcContext without sendNotify silently drops ctx.notify
    const standaloneCtx = createRpcContext({
      method: 'standalone',
      id: 1,
      isNotification: false,
    })
    expect(standaloneCtx.clientId).toBeUndefined()
    expect(standaloneCtx.canNotify).toBe(false)
    expect(await standaloneCtx.notify(job.ping)).toBe(false)
  })
})

describe('createServer — adversarial security & failure isolation', () => {
  it('rejects Object.prototype keys with -32601 and resists prototype pollution', async () => {
    const app = defineService(() => ({
      ping: defineMethod(() => 'pong' as const),
      echo: defineMethod((params: Record<string, unknown>) => params),
    }))
    const server = createServer(app)

    for (const key of [
      '__proto__',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
    ]) {
      expect(
        await server.handle({ jsonrpc: '2.0', id: key, method: key })
      ).toEqual({
        jsonrpc: '2.0',
        id: key,
        error: {
          code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: 'Method not found',
        },
      })
    }

    const rawProtoPayload =
      '{"jsonrpc":"2.0","id":1,"method":"echo","__proto__":{"polluted":true},"params":{"__proto__":{"polluted":true},"ok":1}}'
    const parsed = parseJsonRpcPayload(rawProtoPayload)
    expect(parsed.ok).toBe(true)
    const res = await server.handleRaw(rawProtoPayload)
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: JSON.parse('{"__proto__":{"polluted":true},"ok":1}'),
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    // Own __proto__ key inside a service tree does not mutate prototype chain
    const customTree: Record<string, ReturnType<typeof defineMethod>> = {}
    Object.defineProperty(customTree, '__proto__', {
      value: defineMethod(() => 'own'),
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const wrapped = defineService(() => {
      onBefore(() => {})
      return customTree
    })
    expect(Object.getPrototypeOf(wrapped)).toBe(Object.prototype)
    expect(compileService(wrapped).methods.has('__proto__')).toBe(true)
  })

  it('isolates throwing setupContext, onAfter, and onError hooks without unhandled rejections', async () => {
    const observed: string[] = []
    let afterTaskRan = false

    const app = defineService(() => {
      onError(async (err) => {
        observed.push(
          `first:${err instanceof Error ? err.message : String(err)}`
        )
        throw new Error('sync-or-async-observer-crash')
      })
      onError((err) => {
        observed.push(
          `second:${err instanceof Error ? err.message : String(err)}`
        )
      })
      onAfter((result) => {
        if (result === 'fail-after-rpc') {
          throw new JsonRpcError(-32040, 'After rejected')
        }
        if (result === 'fail-after-unknown') {
          throw new Error('secret after failure')
        }
      })

      const run = defineMethod(({ mode }: { mode?: string } = {}, ctx) => {
        ctx.after(() => {
          afterTaskRan = true
        })
        return mode ?? 'ok'
      })
      return { run }
    })

    const server = createServer(app)

    // setupContext throwing JsonRpcError preserves wire error and runs all error hooks
    const authErr = await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'run' },
      {
        async setupContext() {
          throw new JsonRpcError(-32001, 'Unauthorized')
        },
      }
    )
    expect(authErr).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'Unauthorized' },
    })
    expect(observed).toEqual(['first:Unauthorized', 'second:Unauthorized'])

    // setupContext throwing unexpected Error masks to -32603
    observed.length = 0
    const unknownErr = await server.handle(
      { jsonrpc: '2.0', id: 2, method: 'run' },
      {
        setupContext() {
          throw new Error('db connection string')
        },
      }
    )
    expect(unknownErr).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })
    expect(observed).toEqual([
      'first:db connection string',
      'second:db connection string',
    ])

    // setupContext throwing on Notification returns undefined
    expect(
      await server.handle(
        { jsonrpc: '2.0', method: 'run' },
        {
          setupContext() {
            throw new JsonRpcError(-32001, 'Unauthorized')
          },
        }
      )
    ).toBeUndefined()

    // onAfter throwing JsonRpcError routes to onError, skips ctx.after, and returns error
    observed.length = 0
    afterTaskRan = false
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'run',
        params: { mode: 'fail-after-rpc' },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32040, message: 'After rejected' },
    })
    expect(observed).toEqual(['first:After rejected', 'second:After rejected'])
    expect(afterTaskRan).toBe(false)

    // onAfter throwing unexpected Error masks to -32603
    observed.length = 0
    expect(
      await server.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'run',
        params: { mode: 'fail-after-unknown' },
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      },
    })
    expect(observed).toEqual([
      'first:secret after failure',
      'second:secret after failure',
    ])
  })
})
