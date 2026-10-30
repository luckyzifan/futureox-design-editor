import {defineConfig} from 'vitest/config'
export default defineConfig({resolve:{preserveSymlinks:true},test:{setupFiles:['src/test-setup.ts'],include:['src/canvas-overlay-capture-chain.test.tsx'],maxWorkers:1,fileParallelism:false,testTimeout:30000,hookTimeout:30000}})
