import { createHttpHandler, httpTransport } from '../src/http'
import {
  createClient,
  createProxy,
  createServer,
  defineContext,
  defineError,
  defineMethod,
  defineService,
  onBefore,
} from '../src/index'

const ApiKey = defineContext<string | null>()
const Unauthorized = defineError(-32001, 'Unauthorized')
const DivByZero = defineError(-32002, 'Division by zero')
const Overflow = defineError(-32003, 'Overflow').data<{ max: number }>()

const math = defineService(() => {
  onBefore((ctx) => {
    if (ctx.get(ApiKey) !== 'secret') {
      return Unauthorized()
    }
  })

  const divide = defineMethod(({ a, b }: { a: number; b: number }) => {
    if (b === 0) return DivByZero()
    if (a > 1e6) return Overflow({ max: 1e6 })
    return a / b
  })

  const sum = defineMethod(([a, b]: [number, number]) => a + b)

  return { divide, sum }
})

const app = defineService(() => {
  const ping = defineMethod(() => 'pong' as const)
  const log = defineMethod(({ message }: { message: string }) => {
    console.log('[server log]', message)
  })

  return { ping, log, math }
})

type App = typeof app

const rpcServer = createServer(app)
const server = Bun.serve({
  port: 0,
  fetch: createHttpHandler(rpcServer, {
    setupContext(ctx, req) {
      ctx.set(ApiKey, req.headers.get('x-api-key'))
    },
  }),
})

try {
  const client = createClient<App>(
    httpTransport(`http://127.0.0.1:${server.port}/rpc`, {
      headers: { 'x-api-key': 'secret' },
    })
  )

  const okRes = await client.call('math.divide', { a: 10, b: 2 })
  console.log('divide(10, 2):', okRes)

  const errRes = await client.call('math.divide', { a: 2e6, b: 2 })
  if (!errRes.ok && Overflow.is(errRes.error)) {
    console.log('overflow error max:', errRes.error.data.max)
  }

  const [divRes, sumRes, logRes] = await client.batch((b) => [
    b.call('math.divide', { a: 9, b: 0 }),
    b.call('math.sum', [3, 4]),
    b.notify('log', { message: 'hello from batch' }),
  ])
  console.log('batch:', { divRes, sumRes, logRes })

  const rpc = createProxy(client)
  console.log('proxy ping:', await rpc.ping())
  console.log('proxy sum:', await rpc.math.sum([20, 22]))

  await client.notify('log', { message: 'all done' })
} finally {
  await server.stop(true)
}
