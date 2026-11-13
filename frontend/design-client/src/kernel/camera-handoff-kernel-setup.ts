import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll } from 'vitest'
import { initializeKernelModule } from './module'

beforeAll(async () => {
  // A path string, not a URL object: jsdom replaces URL and Node then rejects it.
  const wasm = new Uint8Array(await readFile(resolve(process.cwd(), 'public/kernel/design_kernel_bg.wasm')))
  await initializeKernelModule(wasm)
})
