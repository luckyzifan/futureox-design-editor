import { expect,test,vi } from 'vitest'
import { localHomeSource, admitHomeDocumentCommand } from './local-home-source'
import type { DesktopSession } from './desktop-session'
const entries=[{id:'local-a',name:'A',revision:1,updatedAt:123,deleted:false}]
function web(){return {list:vi.fn(async()=>entries),open:vi.fn(async(_id:string)=>true)}}
function desktop(workspace=true){return {supportsWorkspace:workspace,listWorkspace:vi.fn(async()=>({status:'ok' as const,documents:entries})),openWorkspace:vi.fn(async(_id:string)=>true),status:{error:null}} as unknown as Pick<DesktopSession,'supportsWorkspace'|'listWorkspace'|'openWorkspace'|'status'>}
test('Web metadata listing and opening use only supplied local store callbacks',async()=>{
 const storage=web(),source=localHomeSource(null,storage);expect(source.kind).toBe('web-local');expect(await source.list()).toEqual(entries);expect(storage.open).not.toHaveBeenCalled();expect(await source.open('local-a')).toBe(true);expect(storage.open).toHaveBeenCalledWith('local-a')
})
test('Electron workspace uses capability API and never falls back to browser IndexedDB',async()=>{
 const native=desktop(),storage=web(),source=localHomeSource(native,storage);expect(source.kind).toBe('desktop-workspace');expect(await source.list()).toEqual(entries);expect(native.listWorkspace).toHaveBeenCalledWith(false);expect(native.openWorkspace).not.toHaveBeenCalled();expect(await source.open('local-a')).toBe(true);expect(native.openWorkspace).toHaveBeenCalledWith('local-a');expect(storage.list).not.toHaveBeenCalled();expect(storage.open).not.toHaveBeenCalled()
})
test('file-only Electron explicitly has no recent workspace capability, rather than loading web documents',async()=>{
 const native=desktop(false),storage=web(),source=localHomeSource(native,storage);expect(source.kind).toBe('desktop-files');expect(await source.list()).toEqual([]);expect(await source.open('x')).toBe(false);expect(native.listWorkspace).not.toHaveBeenCalled();expect(storage.list).not.toHaveBeenCalled()
})
test('native cancellation stays false; native list/open failure is not converted to success',async()=>{
 const native=desktop(),source=localHomeSource(native,web());vi.mocked(native.openWorkspace).mockResolvedValue(false);expect(await source.open('a')).toBe(false)
 native.status.error='Disk unavailable';await expect(source.open('a')).rejects.toThrow('Disk unavailable')
 vi.mocked(native.listWorkspace).mockResolvedValue({status:'error',code:'IO',message:'Read failed'});await expect(source.list()).rejects.toThrow('Read failed')
})

const available = {ready:true,switching:false,busy:false,transitioning:false,interactionActive:false,modalOwnsFocus:false}
test.each(['new','open','openPending'])('native Home %s respects every command ownership gate',name=>{
 expect(admitHomeDocumentCommand(name,available)).toBe(true)
 expect(admitHomeDocumentCommand(name,{...available,ready:false})).toBe(false)
 for(const key of ['switching','busy','transitioning','interactionActive','modalOwnsFocus'] as const)
  expect(admitHomeDocumentCommand(name,{...available,[key]:true})).toBe(false)
})
test('Home admission excludes hidden editor and settings commands; local preferences have their independent entry',()=>{
 for(const name of ['save','saveAs','recover','undo','redo','delete','settings'])expect(admitHomeDocumentCommand(name,available)).toBe(false)
})
