import {readFileSync} from 'node:fs'
import initialize from '../../generated/design-kernel/design_kernel.js'
// Synthetic driver graphs still use the production Rust topology/ownership
// planner. Coordinate generation and GPU pixels remain explicit test doubles.
await initialize({module_or_path:await WebAssembly.compile(readFileSync(new URL('../../generated/design-kernel/design_kernel_bg.wasm',import.meta.url)))})
export {compiled_scene_plan_json} from '../../generated/design-kernel/design_kernel.js'
