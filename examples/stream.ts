import {
  createPeer,
  defineMethod,
  defineNotify,
  defineService,
} from '../src/index'
import { streamTransport } from '../src/stream'

const app = defineService(() => {
  const status = defineNotify<{ text: string }>()

  const greet = defineMethod(async ({ name }: { name: string }, ctx) => {
    await ctx.notify(status, { text: `Greeting ${name} 🚀` })
    return `Hello, ${name}!`
  })

  return { greet, status }
})

type App = typeof app

const clientToServer = new TransformStream<Uint8Array, Uint8Array>()
const serverToClient = new TransformStream<Uint8Array, Uint8Array>()

const serverPeer = createPeer<never, App>(
  streamTransport({
    readable: clientToServer.readable,
    writable: serverToClient.writable,
    framing: 'content-length',
  }),
  app
)

const clientPeer = createPeer<App>(
  streamTransport({
    readable: serverToClient.readable,
    writable: clientToServer.writable,
    framing: 'content-length',
  })
)

try {
  const statusReceived = new Promise<void>((resolve) => {
    clientPeer.on('status', ({ text }) => {
      console.log('[stream notification]', text)
      resolve()
    })
  })

  const res = await clientPeer.call('greet', { name: 'krpc' })
  await statusReceived
  console.log('greet result:', res)
} finally {
  await clientPeer.close()
  await serverPeer.close()
}
