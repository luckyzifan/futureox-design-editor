import helper from './prefix-int128.wgsl?raw'
import shader from './texture-prefix.wgsl?raw'
import certifiedPrefix from './certified-prefix.wgsl?raw'
import widePrefix from './prefix-int256.wgsl?raw'
import { exactFilterWgsl } from './exact-filter'
export function prefixModule(certified: boolean) {
  const factor = import.meta.env.VITE_DESIGN_PREFIX_FACTOR !== '0'
  const scan64 = import.meta.env.VITE_DESIGN_PREFIX_SCAN64 !== '0'
  const tight = import.meta.env.VITE_DESIGN_PREFIX_TIGHT_BOUND === '1'
  const interval=certified&&import.meta.env.VITE_DESIGN_CERTIFIED_TENT_PREFIX==='1'
  const bounded=import.meta.env.VITE_DESIGN_BOUNDED_SHADOW_TENT!=='0'
  const wide=certified&&(import.meta.env.VITE_DESIGN_WIDE_RATIONAL_PREFIX==='1'||bounded)
  const wideSource=wide?widePrefix:'fn prefixRational256(base:u32,x:u32,length:u32,interior:u32,quantum:i32)->vec2<u32>{return vec2<u32>(0u);}'
  return exactFilterWgsl(certified) + `\nconst PREFIX_FACTOR:bool=${factor};\nconst PREFIX_SCAN64:bool=${scan64};\nconst PREFIX_TIGHT_BOUND:bool=${tight};\nconst PREFIX_CERTIFIED_TENT:bool=${interval};\nconst PREFIX_WIDE_RATIONAL:bool=${wide};\nconst PREFIX_MAX_RATIONAL_RADIUS:u32=${import.meta.env.VITE_DESIGN_LARGE_SHADOW_TENT==='1'||bounded?4096:2048}u;\n` + helper + certifiedPrefix + wideSource + shader
}
