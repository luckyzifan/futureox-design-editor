import {fileURLToPath} from 'node:url'
export default {root:fileURLToPath(new URL('../../frontend/design-client',import.meta.url)),test:{setupFiles:['./src/test-setup.ts'],include:[fileURLToPath(new URL('./validate-scenes.test.ts',import.meta.url))],testTimeout:120000,maxWorkers:1}}
