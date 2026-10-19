// Exact delivered Canvas source is loaded in-place, preserving every relative
// production import. No rewritten baseline code or generated build is needed.
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const originalCanvas=fileURLToPath(new URL('./src/Canvas.tsx',import.meta.url))
const baseline=fileURLToPath(new URL('../../testing/verification-canvas-scene-reuse-20261019/baseline/Canvas.tsx',import.meta.url))
export default defineConfig({
  plugins:process.env.CANVAS_SCENE_BASELINE==='1'?[{name:'exact-delivered-canvas',enforce:'pre',load(id){
    if(id.split('?')[0]!==originalCanvas)return
    const source=readFileSync(baseline,'utf8')
    if(createHash('sha256').update(source).digest('hex')!=='f04c992f19561fc13973be193a6571a287a4139d6c92f5aa8eb25583e23045e3')throw new Error('Canvas baseline fixture no longer matches the delivered ZIP')
    return source
  }}]:[],
  test:{setupFiles:['./src/test-setup.ts'],include:['src/canvas-scene-reuse-cpu.test.tsx'],maxWorkers:1},
})
