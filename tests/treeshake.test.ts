import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const rootDir = resolve(import.meta.dir, '..')
const indexEntry = resolve(rootDir, 'src/index.ts')
const httpEntry = resolve(rootDir, 'src/http.ts')

async function bundleClientOnly(minify: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: ['/virtual/client-only.ts'],
    files: {
      '/virtual/client-only.ts': `
        import { createClient } from ${JSON.stringify(indexEntry)}
        import { httpTransport } from ${JSON.stringify(httpEntry)}
        export const client = createClient(httpTransport('https://api.example.com/rpc'))
      `,
    },
    minify,
    target: 'browser',
    format: 'esm',
  })

  if (!result.success) {
    throw new Error(
      `Bun.build failed: ${result.logs.map((l) => l.message).join('; ')}`
    )
  }

  return result.outputs[0]!.text()
}

describe('tree-shaking regression', () => {
  it('eliminates server, service, peer, proxy, ws, stream, and http handler code from a client-only bundle', async () => {
    const unminified = await bundleClientOnly(false)
    const minified = await bundleClientOnly(true)

    const eliminatedSymbols = [
      'createServer',
      'defineService',
      'createPeer',
      'createProxy',
      'wsTransport',
      'streamTransport',
      'createHttpHandler',
      'createMemoryTransport',
      'createMemoryDuplexPair',
    ]

    for (const symbol of eliminatedSymbols) {
      expect(unminified).not.toContain(symbol)
    }

    const eliminatedStrings = [
      'Batch size exceeds maximum',
      'defineService() setup function must be synchronous',
      'Method Not Allowed',
      'Unsupported Media Type',
      'WebSocket is closed',
      'Content-Length',
      'Transport closed',
    ]

    for (const marker of eliminatedStrings) {
      expect(minified).not.toContain(marker)
    }

    const minifiedBytes = new TextEncoder().encode(minified).byteLength
    expect(minifiedBytes).toBeLessThan(8 * 1024)
  })
})
