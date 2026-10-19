import { beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking } from './kernel/picking'
beforeAll(async () => {
  await initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  })
})
