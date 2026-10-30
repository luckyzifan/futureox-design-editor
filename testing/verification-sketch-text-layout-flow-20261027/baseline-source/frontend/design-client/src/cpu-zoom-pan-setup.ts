import { beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { initializePicking } from './kernel/picking'
beforeAll(async () => {
  await initializePicking({
    wasm: readFileSync(process.env.CPU_ZOOM_PAN_WASM || 'public/kernel/design_kernel_bg.wasm'),
    font: readFileSync('public/fonts/NotoSansSC.ttf'),
  })
})
