import { ShortcutApi } from '../generated/design-kernel/design_kernel'
import { kernelModuleReady } from './module'
import { TOOL_COMMANDS, toolForCommand } from '../tool-registry'
import type { Tool } from '../engine'
let table: ShortcutApi | undefined
/** One parsed Rust table per application, shared by all editor windows here. */
export function resolveToolShortcut(key:string,os:'mac'|'windows'|'linux'):Tool|null {
  if (!kernelModuleReady()) return null
  table ??= new ShortcutApi(JSON.stringify({schemaVersion:1,actions:Object.fromEntries(
    TOOL_COMMANDS.filter(c=>c.tool&&c.shortcut).map(c=>[c.id,{editModes:['canvas'],bindings:['mac','windows','linux'].map(os=>({combo:c.shortcut,os}))}])
  )}))
  const action=table.actions(key.length===1?key.toUpperCase():key,os)[0]
  return action ? toolForCommand(action) as Tool|null : null
}
