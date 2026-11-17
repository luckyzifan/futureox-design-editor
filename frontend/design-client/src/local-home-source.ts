import type { DesktopSession } from './desktop-session'
import type { LocalEntry } from './local-store'

export type HomeEntry = Pick<LocalEntry,'id'|'name'|'revision'|'updatedAt'|'deleted'>
/** Per-document metadata operations surfaced on Home entries. Optional per
 * source kind: only the desktop workspace session owns all three today. */
export type HomeDocumentOps = {
  rename:(id:string,name:string)=>Promise<boolean>
  duplicate:(id:string)=>Promise<boolean>
  trash:(id:string,revision:number)=>Promise<boolean>
}
export type HomeSource = { kind:'web-local'|'desktop-workspace'|'desktop-files'; list:()=>Promise<HomeEntry[]>; open:(id:string)=>Promise<boolean>; ops?:HomeDocumentOps }
type DesktopHomeSession = Pick<DesktopSession,'supportsWorkspace'|'listWorkspace'|'openWorkspace'|'status'|'trashWorkspace'|'renameWorkspaceFile'|'duplicateWorkspaceFile'>
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
  },ops:{
    rename:(id,name)=>desktop.renameWorkspaceFile(id,name),
    duplicate:id=>desktop.duplicateWorkspaceFile(id),
    trash:async(id,revision)=>{
      const result=await desktop.trashWorkspace({id,revision})
      if(result.status==='cancelled')return false
      if(result.status!=='ok')throw new Error(result.message)
      return true
    }
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
