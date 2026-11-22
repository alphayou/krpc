import {
  createPeer,
  defineMethod,
  defineNotify,
  defineService,
} from '../src/index'
import { stdioTransport } from '../src/stdio'

const app = defineService(() => {
  const status = defineNotify<{ text: string }>()

  const greet = defineMethod(async ({ name }: { name: string }, ctx) => {
    await ctx.notify(status, { text: `Greeting ${name}` })
    return `Hello, ${name}!`
  })

  return { greet, status }
})

type App = typeof app

if (process.argv.includes('--worker')) {
  // Child process: serve over process.stdin / process.stdout
  createPeer(stdioTransport(), app)
} else {
  // Parent process: spawn itself as a child worker over OS stdio pipes
  const proc = Bun.spawn([process.execPath, import.meta.path, '--worker'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })

  const peer = createPeer<App>(
    stdioTransport({
      input: proc.stdout,
      output: proc.stdin,
    })
  )

  try {
    const statusReceived = new Promise<void>((resolve) => {
      peer.on('status', ({ text }) => {
        console.log('[stdio notification]', text)
        resolve()
      })
    })

    const res = await peer.call('greet', { name: 'krpc' })
    await statusReceived
    console.log('greet result:', res)
  } finally {
    await peer.close()
    await proc.exited
  }
}
