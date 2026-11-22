import { createBunHandler } from '../src/bun'
import {
  createPeer,
  createServer,
  defineMethod,
  defineNotify,
  defineService,
} from '../src/index'
import { wsTransport } from '../src/ws'

const app = defineService(() => {
  const progress = defineNotify<{ jobId: string; percent: number }>()
  const done = defineNotify<{ jobId: string }>()

  const start = defineMethod(({ jobId }: { jobId: string }, ctx) => {
    ctx.after(async () => {
      await ctx.notify(progress, { jobId, percent: 50 })
      await ctx.notify(progress, { jobId, percent: 100 })
    })
    return { accepted: true, jobId, clientId: ctx.clientId }
  })

  return { job: { start, progress, done } }
})

type App = typeof app

const rpcServer = createServer(app)
const bunServer = Bun.serve({
  port: 0,
  ...createBunHandler(rpcServer, {
    path: '/rpc',
    id: (req) => new URL(req.url).searchParams.get('clientId') ?? undefined,
  }),
})

const clientPeer = createPeer<App>(
  wsTransport(
    new WebSocket(`ws://127.0.0.1:${bunServer.port}/rpc?clientId=demo-1`)
  )
)

try {
  const progressDone = new Promise<void>((resolve) => {
    clientPeer.on('job.progress', ({ jobId, percent }) => {
      console.log(`[client on job.progress] ${jobId}: ${percent}%`)
      if (percent === 100) resolve()
    })
  })

  const doneReceived = new Promise<void>((resolve) => {
    clientPeer.on('job.done', ({ jobId }) => {
      console.log('[client on job.done]', jobId)
      resolve()
    })
  })

  const startRes = await clientPeer.call('job.start', { jobId: 'job-1' })
  console.log('job.start result:', startRes)
  await progressDone

  await rpcServer.notify('demo-1', 'job.done', { jobId: 'job-1' })
  await doneReceived
} finally {
  await clientPeer.close()
  await bunServer.stop(true)
}
