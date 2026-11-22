import {
  createPeer,
  defineMethod,
  defineNotify,
  defineService,
  type KrpcPeer,
} from '../src/index'
import {
  createWsServerTransport,
  wsTransport,
  type WsServerTransportBridge,
} from '../src/ws'

const app = defineService(() => {
  const progress = defineNotify<{ jobId: string; percent: number }>()
  const done = defineNotify<{ jobId: string }>()

  const start = defineMethod(async ({ jobId }: { jobId: string }, ctx) => {
    await ctx.notify(progress, { jobId, percent: 50 })
    await ctx.notify(progress, { jobId, percent: 100 })
    return { started: true, jobId }
  })

  return { job: { start, progress, done } }
})

type App = typeof app

const connections = new WeakMap<
  object,
  { bridge: WsServerTransportBridge; peer: KrpcPeer<never, App> }
>()
let latestServerPeer: KrpcPeer<never, App> | undefined

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined
    return new Response('WebSocket upgrade required', { status: 426 })
  },
  websocket: {
    open(ws) {
      const bridge = createWsServerTransport(ws)
      const peer = createPeer<never, App>(bridge.transport, app)
      connections.set(ws, { bridge, peer })
      latestServerPeer = peer
    },
    message(ws, data) {
      connections.get(ws)?.bridge.handleMessage(data)
    },
    close(ws, code, reason) {
      connections.get(ws)?.bridge.handleClose({ code, reason })
    },
  },
})

const clientPeer = createPeer<App>(
  wsTransport(new WebSocket(`ws://127.0.0.1:${server.port}`))
)

try {
  const doneReceived = new Promise<void>((resolve) => {
    clientPeer.on('job.done', ({ jobId }) => {
      console.log('[client on job.done]', jobId)
      resolve()
    })
  })

  clientPeer.on('job.progress', ({ jobId, percent }) => {
    console.log(`[client on job.progress] ${jobId}: ${percent}%`)
  })

  const startRes = await clientPeer.call('job.start', { jobId: 'job-1' })
  console.log('job.start result:', startRes)

  await latestServerPeer?.notify('job.done', { jobId: 'job-1' })
  await doneReceived
} finally {
  await clientPeer.close()
  await server.stop(true)
}
