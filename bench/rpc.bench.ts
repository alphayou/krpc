import {
  createClient,
  createMemoryTransport,
  createServer,
  defineMethod,
  defineService,
} from '../src/index'
import {
  createContentLengthDecoder,
  createNdjsonDecoder,
  encodeContentLengthFrame,
  encodeNdjsonFrame,
} from '../src/stream'

interface BenchResult {
  readonly name: string
  readonly opsPerSec: number
  readonly avgUs: number
  readonly unit: string
}

async function benchAsync(
  name: string,
  fn: () => Promise<unknown>,
  iterations: number,
  warmup = Math.min(500, Math.floor(iterations / 10)),
  unit = 'ops/sec'
): Promise<BenchResult> {
  for (let i = 0; i < warmup; i++) {
    await fn()
  }
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    await fn()
  }
  const elapsedMs = performance.now() - start
  const opsPerSec = (iterations / elapsedMs) * 1000
  const avgUs = (elapsedMs * 1000) / iterations
  return { name, opsPerSec, avgUs, unit }
}

function benchSync(
  name: string,
  fn: () => void,
  iterations: number,
  warmup = Math.min(1000, Math.floor(iterations / 10)),
  unit = 'msgs/sec'
): BenchResult {
  for (let i = 0; i < warmup; i++) {
    fn()
  }
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    fn()
  }
  const elapsedMs = performance.now() - start
  const opsPerSec = (iterations / elapsedMs) * 1000
  const avgUs = (elapsedMs * 1000) / iterations
  return { name, opsPerSec, avgUs, unit }
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

const app = defineService(() => ({
  math: {
    add: defineMethod(({ a, b }: { a: number; b: number }) => a + b),
  },
}))

const server = createServer(app)
const client = createClient<typeof app>(createMemoryTransport(server))

const singleReq = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'math.add',
  params: { a: 21, b: 21 },
}

const batch20Req = Array.from({ length: 20 }, (_, i) => ({
  jsonrpc: '2.0' as const,
  id: i + 1,
  method: 'math.add',
  params: { a: i, b: i + 1 },
}))

const sampleFrameJson = JSON.stringify(singleReq)

let ndjsonCount = 0
const ndjsonDecoder = createNdjsonDecoder(() => {
  ndjsonCount++
})

let clCount = 0
const clDecoder = createContentLengthDecoder(() => {
  clCount++
})

const results: BenchResult[] = []

results.push(
  await benchAsync(
    'server.handle (single)',
    () => server.handle(singleReq),
    50_000
  )
)

results.push(
  await benchAsync(
    'server.handle (batch-20)',
    () => server.handle(batch20Req),
    10_000
  )
)

results.push(
  await benchAsync(
    'client + memoryTransport (round-trip)',
    () => client.call('math.add', { a: 21, b: 21 }),
    50_000
  )
)

results.push(
  benchSync(
    'stream NDJSON (encode + decode)',
    () => {
      ndjsonDecoder.push(encodeNdjsonFrame(sampleFrameJson))
    },
    100_000
  )
)

results.push(
  benchSync(
    'stream Content-Length (encode + decode)',
    () => {
      clDecoder.push(encodeContentLengthFrame(sampleFrameJson))
    },
    100_000
  )
)

if (ndjsonCount === 0 || clCount === 0) {
  throw new Error('Stream decoder produced no messages')
}

console.log('\nkrpc benchmark results:\n')
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(42)} ${formatNumber(r.opsPerSec).padStart(12)} ${r.unit.padEnd(9)} (${r.avgUs.toFixed(2)} us)`
  )
}
console.log('')
