import { describe, expect, it } from 'bun:test'
import { createClient } from '../src/client/client'
import { createProxy } from '../src/client/proxy'
import { createPeer } from '../src/peer/peer'
import { defineError } from '../src/protocol/errors'
import type { StandardSchemaV1 } from '../src/protocol/standard-schema'
import type {
  JsonRpcErrorObject,
  Result,
  StandardRpcError,
} from '../src/protocol/types'
import { createServer } from '../src/server/server'
import { createRpcContext, defineContext } from '../src/service/context'
import { defineMethod, defineNotify } from '../src/service/method'
import { defineService } from '../src/service/service'
import type {
  InferError,
  InferInput,
  InferNotify,
  InferOutput,
  MethodNames,
  NotifyNames,
} from '../src/service/types'
import type { ClientTransport, DuplexTransport } from '../src/transports/types'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

function assertType<T extends true>(_check?: T): void {}

const Unauthorized = defineError(-32001, 'Unauthorized')
const DivByZero = defineError(-32002, 'Division by zero')
const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()
const Quota = defineError(-32004, 'Quota exceeded').data<{ limit: number }>()

const divideSchema: StandardSchemaV1<
  { a: number; b?: number },
  { a: number; b: number }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) => ({ value: v as { a: number; b: number } }),
  },
}

const numberSchema: StandardSchemaV1<number, number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) => ({ value: v as number }),
  },
}

const math = defineService(() => {
  const divide = defineMethod(divideSchema, ({ a, b }) => {
    const _bIsRequired: number = b
    void _bIsRequired
    if (b === 0) return DivByZero()
    if (a > 1e9) return Overflow({ max: 1e9 })
    if (a < -1e9) return Quota({ limit: 1e9 })
    return a / b
  })
  const sum = defineMethod(([a, b]: [number, number]) => a + b)
  return { divide, sum }
})

const job = defineService(() => {
  const progress = defineNotify<{ jobId: string; percent: number }>()
  const heartbeat = defineNotify()
  const optional = defineNotify<{ tag?: string } | undefined>()
  const start = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
    const sent1: boolean = await ctx.notify(progress, { jobId, percent: 50 })
    const sent2: boolean = await ctx.notify(
      progress,
      { jobId, percent: 75 },
      'user-1'
    )
    const sent3: boolean = await ctx.notify(heartbeat)
    const sent4: boolean = await ctx.notify(heartbeat, undefined, 'user-1')
    const sent5: boolean = await ctx.notify(optional)
    const sent6: boolean = await ctx.notify(optional, { tag: 'x' }, 'user-1')
    void [sent1, sent2, sent3, sent4, sent5, sent6]
    ctx.after(async () => {
      await ctx.notify(heartbeat)
    })
    const cid: string | undefined = ctx.clientId
    void cid
    return { started: true as const }
  })
  return { progress, heartbeat, optional, start }
})

const app = defineService(() => {
  const ping = defineMethod(() => 'pong' as const)
  const noop = defineMethod(() => {})
  const maybe = defineMethod(({ found }: { found: boolean }) =>
    found ? 'yes' : undefined
  )
  const opt = defineMethod((p?: { tag?: string }) => p?.tag ?? 'none')
  const log = defineMethod(({ message }: { message: string }) => {
    void message
  })
  return { ping, noop, maybe, opt, log, math, job }
})

type App = typeof app

describe('TypeScript 7 compile-time type gymnastics', () => {
  it('passes all positive and negative (@ts-expect-error) type assertions', () => {
    // 1. Flattened method & notify names
    assertType<
      Equal<
        MethodNames<App>,
        | 'ping'
        | 'noop'
        | 'maybe'
        | 'opt'
        | 'log'
        | 'math.divide'
        | 'math.sum'
        | 'job.start'
      >
    >(true)
    assertType<
      Equal<NotifyNames<App>, 'job.progress' | 'job.heartbeat' | 'job.optional'>
    >(true)

    // 2. Standard Schema Input vs Output separation & void/undefined -> null wire normalization
    assertType<
      Equal<InferInput<App, 'math.divide'>, { a: number; b?: number }>
    >(true)
    assertType<Equal<InferOutput<App, 'math.divide'>, number>>(true)
    assertType<Equal<InferOutput<App, 'ping'>, 'pong'>>(true)
    assertType<Equal<InferOutput<App, 'noop'>, null>>(true)
    assertType<Equal<InferOutput<App, 'maybe'>, 'yes' | null>>(true)
    assertType<
      Equal<
        InferNotify<App, 'job.progress'>,
        { jobId: string; percent: number }
      >
    >(true)

    // 3. defineError literal codes & discriminated union narrowing
    assertType<Equal<typeof Unauthorized.code, -32001>>(true)
    assertType<Equal<typeof Overflow.code, -32003>>(true)
    assertType<Equal<typeof Quota.code, -32004>>(true)

    type DivideErr = InferError<App, 'math.divide'>
    const checkNarrowing = (err: DivideErr) => {
      if (err.code === -32003) {
        assertType<Equal<typeof err.data, { max: number }>>(true)
      }
      if (err.code === -32004) {
        assertType<Equal<typeof err.data, { limit: number }>>(true)
      }
      if (Overflow.is(err)) {
        assertType<Equal<typeof err.data, { max: number }>>(true)
      }
    }
    void checkNarrowing

    // 4. defineContext required vs defaulted
    const ReqCtx = defineContext<Headers>()
    const DefCtx = defineContext('en-US')
    const checkContext = () => {
      const ctx = createRpcContext({
        method: 'ping',
        id: 1,
        isNotification: false,
      })
      const h = ctx.get(ReqCtx)
      const hReq = ctx.require(ReqCtx)
      const locale = ctx.get(DefCtx)
      assertType<Equal<typeof h, Headers | undefined>>(true)
      assertType<Equal<typeof hReq, Headers>>(true)
      assertType<Equal<typeof locale, string>>(true)
      assertType<Equal<typeof ctx.clientId, string | undefined>>(true)

      const sentVoid = ctx.notify(job.heartbeat)
      assertType<Equal<typeof sentVoid, Promise<boolean>>>(true)
      ctx.after(() => {})
      ctx.after(async () => {})

      // @ts-expect-error void notify requires undefined before target id
      ctx.notify(job.heartbeat, 'user-1')
      // @ts-expect-error invalid target id type
      ctx.notify(job.progress, { jobId: '1', percent: 50 }, 123)
      // @ts-expect-error invalid payload shape
      ctx.notify(job.progress, { jobId: 123, percent: 50 })
    }
    void checkContext

    // 4b. Server connection registry & server.notify typing
    const checkServerRegistry = async (transport: DuplexTransport) => {
      const server = createServer(app)
      const conn = server.connect(transport, 'u1')
      const conn2 = server.connect(transport, {
        id: 'u2',
        setupContext(ctx) {
          assertType<Equal<typeof ctx.clientId, string | undefined>>(true)
        },
      })
      assertType<Equal<typeof conn.id, string>>(true)
      assertType<Equal<typeof conn2.id, string>>(true)

      const s1 = await server.notify('u1', 'job.progress', {
        jobId: '1',
        percent: 50,
      })
      const s2 = await server.notify('u1', 'job.heartbeat')
      const s3 = await server.notify('u1', job.progress, {
        jobId: '1',
        percent: 100,
      })
      const c1 = await conn.notify('job.heartbeat')
      const c2 = await conn.notify(job.progress, { jobId: '1', percent: 10 })
      assertType<Equal<typeof s1, boolean>>(true)
      assertType<Equal<typeof s2, boolean>>(true)
      assertType<Equal<typeof s3, boolean>>(true)
      assertType<Equal<typeof c1, boolean>>(true)
      assertType<Equal<typeof c2, boolean>>(true)

      // @ts-expect-error unknown notification name
      await server.notify('u1', 'job.unknown')
      // @ts-expect-error RPC method is not a notification
      await server.notify('u1', 'ping')
      // @ts-expect-error invalid payload shape
      await server.notify('u1', 'job.progress', { jobId: 1, percent: 50 })
      // @ts-expect-error void notify rejects params
      await server.notify('u1', 'job.heartbeat', { extra: 1 })
      // @ts-expect-error conn.notify rejects unknown notification name
      await conn.notify('ping')
    }
    void checkServerRegistry

    // 5. Client call, notify, batch variadic tuples, and createProxy
    const checkClientAndProxy = async (transport: ClientTransport) => {
      const client = createClient<App>(transport)

      const pong = await client.call('ping')
      assertType<Equal<typeof pong, Result<'pong', StandardRpcError>>>(true)

      const div = await client.call('math.divide', { a: 10 })
      if (div.ok) {
        assertType<Equal<typeof div.value, number>>(true)
      } else if (div.error.code === -32003) {
        assertType<Equal<typeof div.error.data, { max: number }>>(true)
      }

      await client.call('opt')
      await client.call('opt', { tag: 'x' })
      await client.call('ping', undefined, { timeout: 1000 })
      await client.notify('log', { message: 'hi' })
      await client.notify('ping')

      // Variadic batch tuple without `as const`
      const [r0, r1, r2, r3] = await client.batch((b) => [
        b.call('math.divide', { a: 10, b: 2 }),
        b.call('math.sum', [1, 2]),
        b.notify('log', { message: 'done' }),
        b.call('ping'),
      ])
      assertType<Equal<typeof r0, Result<number, DivideErr>>>(true)
      assertType<Equal<typeof r1, Result<number, StandardRpcError>>>(true)
      assertType<Equal<typeof r2, undefined>>(true)
      assertType<Equal<typeof r3, Result<'pong', StandardRpcError>>>(true)

      // Proxy deep paths
      const rpc = createProxy(client)
      const pPing = await rpc.ping()
      const pNoop = await rpc.noop()
      const pDiv = await rpc.math.divide({ a: 10, b: 2 })
      const pSum = await rpc.math.sum([1, 2])
      assertType<Equal<typeof pPing, Result<'pong', StandardRpcError>>>(true)
      assertType<Equal<typeof pNoop, Result<null, StandardRpcError>>>(true)
      assertType<Equal<typeof pDiv, Result<number, DivideErr>>>(true)
      assertType<Equal<typeof pSum, Result<number, StandardRpcError>>>(true)

      // Untyped client ergonomics for external JSON-RPC 2.0 servers (Ethereum, LSP, MCP)
      const extClient = createClient(transport)
      const blockRes = await extClient.call('eth_blockNumber')
      const balRes = await extClient.call(
        'eth_getBalance',
        ['0xabc', 'latest'],
        { timeout: 1000 }
      )
      await extClient.call('eth_blockNumber', undefined, { timeout: 500 })
      await extClient.notify('eth_subscribe', ['newHeads'])
      await extClient.notify('ping')
      assertType<Equal<typeof blockRes, Result<unknown, JsonRpcErrorObject>>>(
        true
      )
      assertType<Equal<typeof balRes, Result<unknown, JsonRpcErrorObject>>>(
        true
      )
      if (!blockRes.ok && blockRes.error.code === 4001) {
        const _msg: string = blockRes.error.message
        void _msg
      }
      const [extR0, extR1] = await extClient.batch((b) => [
        b.call('eth_blockNumber'),
        b.notify('ping'),
      ])
      assertType<Equal<typeof extR0, Result<unknown, JsonRpcErrorObject>>>(true)
      assertType<Equal<typeof extR1, undefined>>(true)

      const extRpc = createProxy(extClient)
      const extProxyRes = await extRpc.eth_blockNumber?.()
      const extNestedRes = await extRpc.user?.get?.({ id: 1 })
      assertType<
        Equal<
          typeof extProxyRes,
          Result<unknown, JsonRpcErrorObject> | undefined
        >
      >(true)
      assertType<
        Equal<
          typeof extNestedRes,
          Result<unknown, JsonRpcErrorObject> | undefined
        >
      >(true)

      // @ts-expect-error untyped client still rejects primitive params per JSON-RPC 2.0
      await extClient.call('eth_getBalance', '0xabc')
      // @ts-expect-error untyped proxy still rejects primitive params
      await extRpc.eth_getBalance?.(123)

      // Negative client & proxy assertions
      // @ts-expect-error unknown method name
      await client.call('does.not.exist')
      // @ts-expect-error void method does not accept params object
      await client.call('ping', { extra: 1 })
      // @ts-expect-error required params cannot be omitted
      await client.call('math.sum')
      // @ts-expect-error tuple params require [number, number]
      await client.call('math.sum', [1, 'two'])
      // @ts-expect-error defineNotify is excluded from client.call
      await client.call('job.progress', { jobId: '1', percent: 10 })
      // @ts-expect-error defineNotify is excluded from RpcProxy
      rpc.job.progress
    }
    void checkClientAndProxy

    // 6. Full-duplex Peer typing
    const checkPeer = async (transport: DuplexTransport) => {
      const serverPeer = createPeer(transport, app)
      await serverPeer.notify('job.progress', { jobId: '1', percent: 50 })
      await serverPeer.notify('job.heartbeat')
      await serverPeer.notify(job.progress, { jobId: '1', percent: 80 })

      const clientPeer = createPeer<App>(transport)
      clientPeer.on('job.progress', ({ jobId, percent }) => {
        assertType<Equal<typeof jobId, string>>(true)
        assertType<Equal<typeof percent, number>>(true)
      })
      clientPeer.on('job.heartbeat', () => {})
      await clientPeer.call('job.start', { jobId: '1' })
      await clientPeer.notify('log', { message: 'hello' })

      // @ts-expect-error invalid notification payload shape
      await serverPeer.notify('job.progress', { jobId: 123, percent: 50 })
      // @ts-expect-error server-only peer (RemoteApp = never) cannot call unknown remote methods
      await serverPeer.call('ping')
      // @ts-expect-error client-only typed peer (LocalApp = never) rejects unknown notify names
      await clientPeer.notify('does.not.exist')
      // @ts-expect-error cannot subscribe to RPC method via peer.on
      clientPeer.on('ping', () => {})

      // Untyped peer ergonomics for external duplex JSON-RPC 2.0 servers (LSP, MCP)
      const extPeer = createPeer(transport)
      const initRes = await extPeer.call('initialize', { processId: null })
      assertType<Equal<typeof initRes, Result<unknown, JsonRpcErrorObject>>>(
        true
      )
      await extPeer.notify('initialized')
      await extPeer.notify('textDocument/didOpen', { uri: 'file:///a.ts' })
      extPeer.on('window/logMessage', (payload) => {
        assertType<Equal<typeof payload, unknown>>(true)
      })
      const [toolsRes, notifSlot] = await extPeer.batch((b) => [
        b.call('tools/list'),
        b.notify('notifications/initialized'),
      ])
      assertType<Equal<typeof toolsRes, Result<unknown, JsonRpcErrorObject>>>(
        true
      )
      assertType<Equal<typeof notifSlot, undefined>>(true)
      // @ts-expect-error untyped peer rejects primitive params
      await extPeer.call('initialize', 42)
      // @ts-expect-error untyped peer rejects primitive notify params
      await extPeer.notify('initialized', 'bad')
    }
    void checkPeer

    // 7. Compile-time reserved error codes & primitive params rejection
    const checkInvalidDefinitions = () => {
      // @ts-expect-error -32700 reserved
      defineError(-32700, 'Parse error')
      // @ts-expect-error -32600 reserved
      defineError(-32600, 'Invalid Request')
      // @ts-expect-error -32601 reserved
      defineError(-32601, 'Method not found')
      // @ts-expect-error -32602 reserved
      defineError(-32602, 'Invalid params')
      // @ts-expect-error -32603 reserved
      defineError(-32603, 'Internal error')
      // @ts-expect-error reserved code before .data<T>()
      defineError(-32600, 'Invalid').data<{ x: number }>()

      // @ts-expect-error primitive number param rejected
      defineMethod((n: number) => n)
      // @ts-expect-error primitive string param rejected
      defineMethod((s: string) => s)
      // @ts-expect-error primitive boolean param rejected
      defineMethod((b: boolean) => b)
      // @ts-expect-error null param rejected
      defineMethod((x: null) => x)
      // @ts-expect-error primitive Standard Schema input rejected
      defineMethod(numberSchema, (n) => n)
      // @ts-expect-error primitive defineNotify rejected
      defineNotify<string>()
      // @ts-expect-error primitive defineNotify schema rejected
      defineNotify(numberSchema)
    }
    void checkInvalidDefinitions

    expect(true).toBe(true)
  })
})
