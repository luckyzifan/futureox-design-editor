import { beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking } from '../../design-client/src/kernel/picking'
beforeAll(async()=>{await initializePicking({wasm:new Uint8Array(await readFile(process.env.FUTUREOX_ARTIFACT_KERNEL_DIR+'/design_kernel_bg.wasm')),font:new Uint8Array(await readFile(new URL('../../design-client/public/fonts/NotoSansSC.ttf',import.meta.url)))})})
