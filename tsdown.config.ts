import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    http: 'src/http.ts',
    ws: 'src/ws.ts',
    bun: 'src/bun.ts',
    stream: 'src/stream.ts',
    stdio: 'src/stdio.ts',
    port: 'src/port.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
})
