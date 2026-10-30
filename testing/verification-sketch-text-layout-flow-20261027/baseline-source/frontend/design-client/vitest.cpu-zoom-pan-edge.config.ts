import {defineConfig} from 'vitest/config'
export default defineConfig({test:{setupFiles:['./src/cpu-zoom-pan-setup.ts'],include:['src/cpu-zoom-pan-edge.benchmark.ts'],maxWorkers:1,hookTimeout:60000}})
