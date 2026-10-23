import { defineConfig } from 'vitest/config'
export default defineConfig({resolve:{preserveSymlinks:true},test:{include:['src/kernel/release-overlay-ownership.integration.test.tsx','src/kernel/resident-presentation.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:15000}})
