import {defineConfig} from '../../frontend/design-client/node_modules/vitest/dist/config.js'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../frontend/design-client',import.meta.url))
const frozen=fileURLToPath(new URL('./before/frontend/design-client/src/Canvas.tsx',import.meta.url))
export default defineConfig({root,plugins:[{name:'frozen-grid-control',enforce:'pre',load(id){
 if(id.split('?')[0]===root+'/src/Canvas.tsx')return readFileSync(frozen,'utf8')
}}],test:{setupFiles:['./src/test-setup.ts'],include:['src/canvas-scene-reuse-cpu.test.tsx'],maxWorkers:1}})
