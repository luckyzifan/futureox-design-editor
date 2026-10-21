import {defineConfig} from 'vitest/config'
export default defineConfig({test:{include:['src/automation/clipboard.test.ts','src/automation/clipboard-mcp.test.ts','src/clipboard-core.test.ts','src/clipboard-roundtrip.test.ts'],setupFiles:['./src/test-setup.ts'],testTimeout:30000,hookTimeout:30000,fileParallelism:false,maxWorkers:1,minWorkers:1,pool:'forks'}})
