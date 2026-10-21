import helper from './prefix-int128.wgsl?raw'
import shader from './texture-prefix.wgsl?raw'
import { exactFilterWgsl } from './exact-filter'
export function prefixModule(certified: boolean) {
  const factor = import.meta.env.VITE_DESIGN_PREFIX_FACTOR !== '0'
  const scan64 = import.meta.env.VITE_DESIGN_PREFIX_SCAN64 !== '0'
  const tight = import.meta.env.VITE_DESIGN_PREFIX_TIGHT_BOUND === '1'
  return exactFilterWgsl(certified) + `\nconst PREFIX_FACTOR:bool=${factor};\nconst PREFIX_SCAN64:bool=${scan64};\nconst PREFIX_TIGHT_BOUND:bool=${tight};\n` + helper + shader
}
