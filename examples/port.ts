import {
  createPeer,
  defineMethod,
  defineNotify,
  defineService,
} from '../src/index'
import { portTransport } from '../src/port'

const workerApp = defineService(() => {
  const progress = defineNotify<{ step: number }>()

  const compute = defineMethod(async ({ n }: { n: number }, ctx) => {
    await ctx.notify(progress, { step: 1 })
    await ctx.notify(progress, { step: 2 })
    return n * 2
  })

  return { compute, progress }
})

type WorkerApp = typeof workerApp

const { port1, port2 } = new MessageChannel()
const workerPeer = createPeer<never, WorkerApp>(portTransport(port1), workerApp)
const mainPeer = createPeer<WorkerApp>(portTransport(port2))

try {
  const steps: number[] = []
  const off = mainPeer.on('progress', ({ step }) => {
    steps.push(step)
    console.log('[port notification] step:', step)
  })

  const res = await mainPeer.call('compute', { n: 21 })
  console.log('compute result:', res, 'steps:', steps)
  off()
} finally {
  await mainPeer.close()
  await workerPeer.close()
}
