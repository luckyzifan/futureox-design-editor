import { beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { initializePicking } from './kernel/picking'
beforeAll(async () => {
  const wasm = new Uint8Array(await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)))
  const expected = process.env.FUTUREOX_EXPECT_KERNEL_SHA256
  if (expected && createHash('sha256').update(wasm).digest('hex') !== expected)
    throw new Error('Test kernel bytes do not match FUTUREOX_EXPECT_KERNEL_SHA256')
  await initializePicking({
    wasm,
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  })
})
