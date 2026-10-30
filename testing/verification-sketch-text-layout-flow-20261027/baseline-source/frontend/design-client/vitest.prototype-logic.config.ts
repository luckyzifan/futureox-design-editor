import { defineConfig } from 'vitest/config'
// Pure expression/state tests: deliberately no GPU, GUI, socket or WASM initialization.
export default defineConfig({test:{include:['src/prototype-logic.test.ts','src/PrototypeLogicBuilder.test.tsx']}})
