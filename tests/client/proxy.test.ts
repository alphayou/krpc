import { describe, expect, it } from 'bun:test'
import { createClient } from '../../src/client/client'
import { createProxy } from '../../src/client/proxy'
import { defineError } from '../../src/protocol/errors'
import { createServer } from '../../src/server/server'
import { defineMethod, defineNotify } from '../../src/service/method'
import { defineService } from '../../src/service/service'
import type { ClientTransport } from '../../src/transports/types'

const DivByZero = defineError(-32002, 'Division by zero')

const app = defineService(() => {
  const ping = defineMethod(() => 'pong' as const)
  const math = defineService(() => {
    const divide = defineMethod(({ a, b }: { a: number; b: number }) => {
      if (b === 0) return DivByZero()
      return a / b
    })
    const sum = defineMethod(([a, b]: [number, number]) => a + b)
    return { divide, sum }
  })
  const deep = defineService(() => ({
    nested: defineService(() => ({
      progress: defineNotify<{ pct: number }>(),
      echo: defineMethod(({ msg }: { msg: string }) => msg),
    })),
  }))

  return { ping, math, deep }
})

type App = typeof app

describe('createProxy', () => {
  it('mirrors nested service paths and forwards params and CallOptions', async () => {
    const server = createServer(app)
    let capturedSignal: AbortSignal | undefined
    const transport: ClientTransport = async (payload, options) => {
      capturedSignal = options?.signal
      return server.handle(payload, { signal: options?.signal })
    }

    const client = createClient<App>(transport)
    const rpc = createProxy(client)

    expect(await rpc.ping()).toEqual({ ok: true, value: 'pong' })
    expect(await rpc.math.divide({ a: 10, b: 2 })).toEqual({
      ok: true,
      value: 5,
    })
    expect(await rpc.math.divide({ a: 10, b: 0 })).toEqual({
      ok: false,
      error: { code: -32002, message: 'Division by zero' },
    })
    expect(await rpc.math.sum([3, 4])).toEqual({ ok: true, value: 7 })

    const ac = new AbortController()
    expect(
      await rpc.deep.nested.echo({ msg: 'hello' }, { signal: ac.signal })
    ).toEqual({ ok: true, value: 'hello' })
    expect(capturedSignal).toBe(ac.signal)
  })

  it('is safe with Promise.resolve, JSON serialization, and symbol inspection', async () => {
    const server = createServer(app)
    const client = createClient<App>(async (p) => server.handle(p))
    const rpc = createProxy(client)

    const resolved = await Promise.resolve(rpc)
    expect(resolved).toBe(rpc)
    expect((rpc as unknown as Record<string, unknown>).then).toBeUndefined()
    expect((rpc as unknown as Record<string, unknown>).toJSON).toBeUndefined()
    expect(
      (rpc as unknown as Record<symbol, unknown>)[Symbol.toStringTag]
    ).toBeUndefined()
  })
})
