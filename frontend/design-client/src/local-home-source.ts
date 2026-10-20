import type { DesktopSession } from './desktop-session'
import type { LocalEntry } from './local-store'

export type HomeEntry = Pick<LocalEntry,'id'|'name'|'revision'|'updatedAt'|'deleted'>
export type HomeSource = { kind:'web-local'|'desktop-workspace'|'desktop-files'; list:()=>Promise<HomeEntry[]>; open:(id:string)=>Promise<boolean> }
type DesktopHomeSession = Pick<DesktopSession,'supportsWorkspace'|'listWorkspace'|'openWorkspace'|'status'>
/** Capability routing only. No backend, authentication, document decoding or
 * preview generation while listing metadata. Opening retains existing guards. */
export function localHomeSource(desktop: DesktopHomeSession | null | undefined, web: { list:()=>Promise<HomeEntry[]>; open:(id:string)=>Promise<boolean> }): HomeSource {
  if (!desktop) return {kind:'web-local',...web}
  if (!desktop.supportsWorkspace) return {kind:'desktop-files',list:async()=>[],open:async()=>false}
  return {kind:'desktop-workspace',list:async()=>{
    const result=await desktop.listWorkspace(false)
    if(result.status==='cancelled')return []
    if(result.status!=='ok')throw new Error(result.message)
    return result.documents
  },open:async id=>{
    const opened=await desktop.openWorkspace(id)
    if(!opened&&desktop.status.error)throw new Error(desktop.status.error)
    return opened
  }}
}

/** Native menus bypass DOM inert/focus boundaries. Admit file operations only
 * when no independent modal or pending editor operation owns the session. */
export function admitHomeDocumentCommand(name: string, state: {
  ready: boolean; switching: boolean; busy: boolean; transitioning: boolean
  interactionActive: boolean; modalOwnsFocus: boolean
}): boolean {
  return ['new', 'open', 'openPending'].includes(name) && state.ready &&
    !state.switching && !state.busy && !state.transitioning &&
    !state.interactionActive && !state.modalOwnsFocus
}
