import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = resolve(import.meta.dir, '..')
const distDir = resolve(rootDir, 'dist')

function distUrl(file: string): string {
  return pathToFileURL(resolve(distDir, file)).href
}

describe('built dist/ ESM artifacts', () => {
  let core: typeof import('../src/index')
  let httpMod: typeof import('../src/http')
  let wsMod: typeof import('../src/ws')
  let streamMod: typeof import('../src/stream')
  let portMod: typeof import('../src/port')

  beforeAll(async () => {
    const required = [
      'index.mjs',
      'http.mjs',
      'ws.mjs',
      'stream.mjs',
      'port.mjs',
    ]
    if (required.some((f) => !existsSync(resolve(distDir, f)))) {
      const proc = Bun.spawnSync(['bun', 'run', 'build'], { cwd: rootDir })
      if (proc.exitCode !== 0) {
        throw new Error(
          `bun run build failed: ${proc.stderr.toString() || proc.stdout.toString()}`
        )
      }
    }

    core = await import(distUrl('index.mjs'))
    httpMod = await import(distUrl('http.mjs'))
    wsMod = await import(distUrl('ws.mjs'))
    streamMod = await import(distUrl('stream.mjs'))
    portMod = await import(distUrl('port.mjs'))
  })

  it('runs Memory, Batch, Proxy, void result, and untyped client end-to-end from dist/index.mjs', async () => {
    const DivByZero = core.defineError(-32002, 'Division by zero')
    const app = core.defineService(() => ({
      ping: core.defineMethod(() => 'pong' as const),
      noop: core.defineMethod(() => {}),
      math: {
        divide: core.defineMethod(({ a, b }: { a: number; b: number }) =>
          b === 0 ? DivByZero() : a / b
        ),
      },
    }))

    const server = core.createServer(app)
    const client = core.createClient<typeof app>(
      core.createMemoryTransport(server)
    )
    const rpc = core.createProxy(client)

    expect(await rpc.ping()).toEqual({ ok: true, value: 'pong' })
    expect(await rpc.noop()).toEqual({ ok: true, value: null })
    expect(await rpc.math.divide({ a: 10, b: 0 })).toEqual({
      ok: false,
      error: { code: -32002, message: 'Division by zero' },
    })

    const [p, d] = await client.batch((b) => [
      b.call('ping'),
      b.call('math.divide', { a: 9, b: 3 }),
    ])
    expect(p).toEqual({ ok: true, value: 'pong' })
    expect(d).toEqual({ ok: true, value: 3 })

    // Untyped client works cleanly out of the box
    const untyped = core.createClient(core.createMemoryTransport(server))
    expect(await untyped.call('ping')).toEqual({ ok: true, value: 'pong' })
    expect(await untyped.call('math.divide', { a: 8, b: 2 })).toEqual({
      ok: true,
      value: 4,
    })
  })

  it('runs HTTP handler + httpTransport from dist/http.mjs', async () => {
    const app = core.defineService(() => ({
      echo: core.defineMethod(({ text }: { text: string }) => text),
      noop: core.defineMethod(() => {}),
    }))
    const server = core.createServer(app)
    const handler = httpMod.createHttpHandler(server)

    const transport = httpMod.httpTransport('https://rpc.test/v1', {
      fetch: (input, init) =>
        handler(
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init)
        ),
    })
    const client = core.createClient<typeof app>(transport)

    expect(await client.call('echo', { text: 'dist-http' })).toEqual({
      ok: true,
      value: 'dist-http',
    })
    expect(await client.call('noop')).toEqual({ ok: true, value: null })
  })

  it('runs Peer over MessageChannel via dist/port.mjs and exposes dist/ws.mjs', async () => {
    expect(typeof wsMod.wsTransport).toBe('function')
    expect(typeof wsMod.createWsServerTransport).toBe('function')

    const progress = core.defineNotify<{ step: number }>()
    const app = core.defineService(() => ({
      progress,
      run: core.defineMethod(async (_, ctx) => {
        await ctx.notify(progress, { step: 1 })
        return 'done'
      }),
    }))

    const { port1, port2 } = new MessageChannel()
    const serverPeer = core.createPeer(portMod.portTransport(port1), app)
    const clientPeer = core.createPeer<typeof app>(portMod.portTransport(port2))

    const events: Array<{ step: number }> = []
    clientPeer.on('progress', (payload) => {
      events.push(payload)
    })

    expect(await clientPeer.call('run')).toEqual({ ok: true, value: 'done' })
    expect(events).toEqual([{ step: 1 }])

    await clientPeer.close()
    await serverPeer.close()
  })

  it('runs Peer over Web Streams with ndjson and content-length framing from dist/stream.mjs', async () => {
    const app = core.defineService(() => ({
      add: core.defineMethod(([a, b]: [number, number]) => a + b),
      noop: core.defineMethod(() => {}),
    }))

    for (const framing of ['ndjson', 'content-length'] as const) {
      const aToB = new TransformStream<Uint8Array, Uint8Array>()
      const bToA = new TransformStream<Uint8Array, Uint8Array>()

      const serverPeer = core.createPeer(
        streamMod.streamTransport({
          readable: aToB.readable,
          writable: bToA.writable,
          framing,
        }),
        app
      )
      const clientPeer = core.createPeer<typeof app>(
        streamMod.streamTransport({
          readable: bToA.readable,
          writable: aToB.writable,
          framing,
        })
      )

      expect(await clientPeer.call('add', [19, 23])).toEqual({
        ok: true,
        value: 42,
      })
      expect(await clientPeer.call('noop')).toEqual({ ok: true, value: null })

      await clientPeer.close()
      await serverPeer.close()
    }
  })
})
