import helper from './prefix-int128.wgsl?raw'
import shader from './texture-prefix.wgsl?raw'
import { exactFilterWgsl } from './exact-filter'
export function prefixModule(certified: boolean) {
  return exactFilterWgsl(certified) + helper + shader
}
