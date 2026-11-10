import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge, WorkspaceBridge, WorkspaceOpened, WorkspaceDocument } from './desktop'
import { pendingEditsChanged, registerPendingEdit } from './pending-edits'

const sessions: DesktopSession[] = []
const ok = { status:'ok' } as const
const cancelled = { status:'cancelled' } as const
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r}); return {promise,resolve} }
function fixture(initial=blank()) {
  const rows=new Map<string,WorkspaceOpened>(), receipts=new Map<string,WorkspaceDocument>()
  const store: WorkspaceBridge = {
    list: vi.fn(async () => ({...ok,documents:[...rows.values()]})),
    open: vi.fn(async ({id}) => rows.has(id) ? {...ok,...rows.get(id)!} : {status:'error' as const,code:'WORKSPACE_NOT_FOUND',message:'missing'}),
    commit: vi.fn(async r => {
      const doc=JSON.parse(r.documentJson), prior=rows.get(doc.id)
      if(receipts.has(r.mutationId)) return {...ok,...receipts.get(r.mutationId)!}
      if((prior?.revision ?? null)!==r.expectedRevision) return {status:'conflict' as const,code:'WORKSPACE_CONFLICT',message:'new revision'}
      const row={id:doc.id,name:doc.name,revision:(prior?.revision||0)+1,hash:'fixture-hash',updatedAt:Date.now(),deleted:false,documentJson:r.documentJson}
      rows.set(doc.id,row);receipts.set(r.mutationId,row);return {...ok,...row}
    }),
    trash: vi.fn(async r => ({...ok,...rows.get(r.id)!,deleted:r.deleted??true})),
    revisions: vi.fn(async ({id}) => ({...ok,revisions:rows.has(id)?[rows.get(id)!]:[]})),
    restore: vi.fn(async r => ({...ok,...rows.get(r.id)!,revision:r.expectedRevision+1})),
  }
  const bridge={workspace:store,version:1,renderPolicy:{cpuOnly:true},readRecovery:vi.fn(async()=>cancelled),writeRecovery:vi.fn(async()=>ok),clearRecovery:vi.fn(async()=>ok),setDirty:vi.fn(async()=>{}),saveDocument:vi.fn(async()=>({...ok,handle:'fixture',displayName:'file.fd'}))} as unknown as DesktopBridge
  const editor=new Editor(initial), confirm=vi.fn(async()=> 'discard' as const)
  const session=new DesktopSession(bridge,editor,confirm);sessions.push(session)
  const rename=(name:string)=>editor.change('Rename',d=>{d.name=name})
  return {editor,session,bridge,store,rows,receipts,rename,confirm}
}
afterEach(()=>{sessions.splice(0).forEach(s=>s.dispose());vi.useRealTimers()})
describe('Rust workspace persistence session',()=>{
  it('commits the full authored snapshot to SQLite without a file dialog',async()=>{
    const f=fixture();await f.session.start();f.rename('Offline design')
    expect(await f.session.save()).toBe(true)
    expect(f.bridge.saveDocument).not.toHaveBeenCalled()
    expect(f.rows.get(f.editor.state.doc.id)?.name).toBe('Offline design')
    expect(f.session.status).toMatchObject({dirty:false,storage:'sqlite',revision:1})
    f.rename('Version two');await f.session.save()
    expect(f.rows.get(f.editor.state.doc.id)?.revision).toBe(2)
  })
  it('reopens the latest durable document on an untouched startup',async()=>{
    const f=fixture(),doc=blank('Stored')
    f.rows.set(doc.id,{id:doc.id,name:doc.name,revision:7,hash:'h',updatedAt:1,deleted:false,documentJson:JSON.stringify(doc)})
    await f.session.start()
    expect(f.editor.state.doc.id).toBe(doc.id)
    expect(f.session.status).toMatchObject({dirty:false,revision:7})
  })
  it('does not overwrite startup edits with a delayed document list',async()=>{
    const f=fixture(),gate=deferred<any>(),doc=blank('Stored')
    vi.mocked(f.store.list).mockReturnValueOnce(gate.promise)
    const task=f.session.start();await flush();f.rename('Keep live edit')
    gate.resolve({...ok,documents:[{id:doc.id,name:'Stored',revision:1,updatedAt:3,deleted:false,hash:'h'}]});await task
    expect(f.editor.state.doc.name).toBe('Keep live edit')
  })
  it('autosaves committed edits but never a drag preview',async()=>{
    vi.useFakeTimers();const doc=blank('Gesture'),n=node('rectangle',10,10,20,20);doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
    const f=fixture(doc);await f.session.start();f.editor.begin('Move');f.editor.preview({[n.id]:{transform:[1,0,0,1,300,200]}})
    await vi.advanceTimersByTimeAsync(650)
    expect(f.store.commit).not.toHaveBeenCalled()
    f.editor.commit();await vi.advanceTimersByTimeAsync(650)
    expect(f.store.commit).toHaveBeenCalledTimes(1)
    expect(JSON.parse(f.rows.get(doc.id)!.documentJson).nodes[n.id].transform[4]).toBe(300)
  })
  it('a full library reports the write was not stored and accepts a later snapshot', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.session.start(); await f.session.save()
    const id = f.editor.state.doc.id
    const stored = f.rows.get(id)!.revision
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'WORKSPACE_STORAGE_FULL', message: 'full' })
    f.rename('Not written')
    await vi.advanceTimersByTimeAsync(650)
    expect(f.session.dirty).toBe(true)
    expect(f.rows.get(id)!.revision).toBe(stored)
    expect(f.session.status.error).toBe('full')
    f.rename('After space returns')
    await vi.advanceTimersByTimeAsync(650)
    expect(f.rows.get(id)!.name).toBe('After space returns')
    expect(f.session.dirty).toBe(false)
  })
  it.each(['BUSY', 'WORKSPACE_BUSY'])('autosaves a property undo after %s using the exact pending receipt', async code => {
    vi.useFakeTimers()
    const doc = blank('Property undo'), text = node('text', 75.85958862304688, 0, 120, 30)
    text.text = 'Original'; doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
    const f = fixture(doc); await f.session.start(); await f.session.save()
    const original = f.rows.get(doc.id)!.documentJson
    f.editor.change('X', d => { d.nodes[text.id].transform[4] = 99.86 })
    await vi.advanceTimersByTimeAsync(650)
    expect(JSON.parse(f.rows.get(doc.id)!.documentJson).nodes[text.id].transform[4]).toBe(99.86)
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code, message: 'Native workspace read owns the gate' })
    f.editor.undo(); expect(JSON.stringify(f.editor.state.doc)).toBe(original)
    await vi.advanceTimersByTimeAsync(650)
    expect(f.session.dirty).toBe(true)
    expect(JSON.parse(f.rows.get(doc.id)!.documentJson).nodes[text.id].transform[4]).toBe(99.86)
    const rejected = vi.mocked(f.store.commit).mock.calls.at(-1)![0]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.rows.get(doc.id)!.documentJson).toBe(original)
    expect(vi.mocked(f.store.commit).mock.calls.at(-1)![0]).toEqual(rejected)
    expect(f.session.status).toMatchObject({ dirty: false, revision: 3, error: undefined })
  })
  it('busy autosaves back off and settle the older receipt before committing newer edits', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.save()
    const busy = { status: 'error', code: 'BUSY', message: 'busy' } as const
    vi.mocked(f.store.commit).mockResolvedValueOnce(busy).mockResolvedValueOnce(busy)
    f.rename('First pending'); await vi.advanceTimersByTimeAsync(600)
    const submitted = vi.mocked(f.store.commit).mock.calls.at(-1)![0]
    await vi.advanceTimersByTimeAsync(599); expect(f.store.commit).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); expect(f.store.commit).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1199); expect(f.store.commit).toHaveBeenCalledTimes(3)
    f.rename('Latest authored')
    await vi.advanceTimersByTimeAsync(650)
    const calls = vi.mocked(f.store.commit).mock.calls.map(call => call[0])
    expect(calls[2]).toEqual(submitted); expect(calls[3]).toEqual(submitted)
    expect(calls[4].mutationId).not.toBe(submitted.mutationId)
    expect(calls[4].expectedRevision).toBe(2)
    expect(f.rows.get(f.editor.state.doc.id)!.documentJson).toBe(JSON.stringify(f.editor.state.doc))
    expect(f.session.status).toMatchObject({ dirty: false, revision: 3, error: undefined })
  })
  it.each(['WORKSPACE_CONFLICT', 'BACKEND_TIMEOUT', 'WORKSPACE_UNAVAILABLE'])('does not loop on non-busy outcome %s', async code => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.save()
    vi.mocked(f.store.commit).mockResolvedValue({ status: code === 'WORKSPACE_CONFLICT' ? 'conflict' : 'error', code, message: 'retained error' })
    f.rename('Unsaved'); await vi.advanceTimersByTimeAsync(60_000)
    expect(f.store.commit).toHaveBeenCalledTimes(2); expect(f.session.dirty).toBe(true)
  })
  it('disposal stops a pending busy autosave retry', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.save()
    vi.mocked(f.store.commit).mockResolvedValue({ status: 'error', code: 'BUSY', message: 'busy' })
    f.rename('Keep dirty'); await vi.advanceTimersByTimeAsync(600)
    f.session.dispose(); await vi.advanceTimersByTimeAsync(60_000)
    expect(f.store.commit).toHaveBeenCalledTimes(2)
  })
  it.each(['interaction', 'busy', 'pending'] as const)('known busy retry survives a temporary %s gate with no authored revision change', async gate => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.save()
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'BUSY', message: 'busy' })
    f.rename('Persist after gate'); await vi.advanceTimersByTimeAsync(600)
    let pending = false
    const unregister = registerPendingEdit(f.editor, { dirty: () => pending, commit: () => false })
    try {
      if (gate === 'interaction') f.editor.begin('Cancelled without changes')
      else if (gate === 'busy') f.editor.set({ busy: true })
      else { pending = true; pendingEditsChanged(f.editor) }
      const version = f.editor.state.version
      await vi.advanceTimersByTimeAsync(600)
      expect(f.store.commit).toHaveBeenCalledTimes(2)
      if (gate === 'interaction') f.editor.cancel()
      else if (gate === 'busy') f.editor.set({ busy: false })
      else { pending = false; pendingEditsChanged(f.editor) }
      expect(f.editor.state.version).toBe(version)
      await vi.advanceTimersByTimeAsync(1200)
      expect(f.rows.get(f.editor.state.doc.id)!.name).toBe('Persist after gate')
      expect(f.session.dirty).toBe(false)
    } finally { unregister() }
  })
  it('close flushes a known busy autosave and never prompts to discard edits', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.save()
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'BUSY', message: 'busy' })
    f.rename('Keep on close'); await vi.advanceTimersByTimeAsync(600)
    expect(await f.session.requestClose()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.store.commit).toHaveBeenCalledTimes(3)
    expect(f.rows.get(f.editor.state.doc.id)?.name).toBe('Keep on close')
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it.each(['transport', 'invalid-ack'] as const)('a %s failure after BUSY stops automatic retry and preserves its pending receipt', async failure => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.save()
    vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'error', code: 'BUSY', message: 'busy' })
    if (failure === 'transport') vi.mocked(f.store.commit).mockRejectedValueOnce(Error('transport lost'))
    else vi.mocked(f.store.commit).mockResolvedValueOnce({ status: 'ok', id: 'wrong-owner', name: 'bad ack', revision: 0, hash: 'bad', updatedAt: 0, deleted: false })
    f.rename('Keep pending'); await vi.advanceTimersByTimeAsync(600)
    const pending = (f.session as any).workspacePending
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.store.commit).toHaveBeenCalledTimes(3)
    expect((f.session as any).workspacePending).toBe(pending)
    expect(f.session.dirty).toBe(true)
    expect(f.session.status.revision).toBe(1)
  })
  it('preserves the canvas and original database row on revision conflict',async()=>{
    const f=fixture();await f.session.start();f.rename('mine');await f.session.save()
    f.rows.get(f.editor.state.doc.id)!.revision=2;f.rename('pending')
    expect(await f.session.save()).toBe(false)
    expect(f.editor.state.doc.name).toBe('pending');expect(f.session.status.conflict).toBe(true)
    expect(f.session.dirty).toBe(true);expect(f.rows.get(f.editor.state.doc.id)!.name).toBe('mine')
  })
  it('reuses the exact mutation ID after an unconfirmed commit',async()=>{
    const f=fixture();await f.session.start();f.rename('Retry safely')
    const original=f.store.commit
    let request: Parameters<WorkspaceBridge['commit']>[0] | undefined
    vi.mocked(f.store.commit).mockImplementationOnce(async r=>{
      request=r;const doc=JSON.parse(r.documentJson),row={id:doc.id,name:doc.name,revision:1,hash:'h',updatedAt:1,deleted:false,documentJson:r.documentJson}
      f.rows.set(doc.id,row);f.receipts.set(r.mutationId,row)
      return {status:'error',code:'BACKEND_TIMEOUT',message:'uncertain'}
    })
    expect(await f.session.save()).toBe(false)
    expect(await f.session.save()).toBe(true)
    const second=vi.mocked(original).mock.calls[1][0]
    expect(second.mutationId).toBe(request!.mutationId)
    expect(second.documentJson).toBe(request!.documentJson)
    expect(f.rows.get(f.editor.state.doc.id)!.revision).toBe(1)
  })
  it('a portable export remains available when the database refuses writes',async()=>{
    const f=fixture();await f.session.start();f.rename('Emergency export')
    vi.mocked(f.store.commit).mockResolvedValue({status:'error',code:'WORKSPACE_UNAVAILABLE',message:'disk full'})
    expect(await f.session.save(true)).toBe(true)
    expect(f.bridge.saveDocument).toHaveBeenCalledWith(expect.objectContaining({saveAs:true}))
    expect(f.session.dirty).toBe(true)
  })
  it('opening a library document first autosaves the current working copy without a prompt',async()=>{
    const f=fixture();await f.session.start();f.rename('Keep');const doc=blank('Other')
    const previous=f.editor.state.doc.id
    f.rows.set(doc.id,{id:doc.id,name:doc.name,revision:1,hash:'h',updatedAt:1,deleted:false,documentJson:JSON.stringify(doc)})
    expect(await f.session.openWorkspace(doc.id)).toBe(true)
    expect(f.rows.get(previous)?.name).toBe('Keep')
    expect(f.editor.state.doc.name).toBe('Other')
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('failed automatic close keeps the document and never offers to discard it',async()=>{
    const f=fixture();await f.session.start();f.rename('Keep after disk failure')
    vi.mocked(f.store.commit).mockResolvedValue({status:'error',code:'WORKSPACE_UNAVAILABLE',message:'disk full'})
    expect(await f.session.requestClose()).toBe(false)
    expect(f.session.dirty).toBe(true)
    expect(f.editor.state.doc.name).toBe('Keep after disk failure')
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('saving a local copy preserves both the conflicting head and the authored changes',async()=>{
    const f=fixture();await f.session.start();f.rename('Original');await f.session.save()
    const originalId=f.editor.state.doc.id
    f.rows.get(originalId)!.revision=2;f.rename('My changes')
    expect(await f.session.save()).toBe(false)
    expect(await f.session.saveCopy()).toBe(true)
    expect(f.editor.state.doc.id).not.toBe(originalId)
    expect(f.editor.state.doc.name).toBe('My changes 副本')
    expect(f.rows.get(originalId)!.name).toBe('Original')
    expect(f.rows.size).toBe(2);expect(f.session.dirty).toBe(false)
  })
  it('will not trash the active document through the library',async()=>{
    const f=fixture();await f.session.start();f.rename('Active');await f.session.save()
    await expect(f.session.trashWorkspace(f.rows.get(f.editor.state.doc.id)!)).rejects.toThrow('先打开其他')
    expect(f.store.trash).not.toHaveBeenCalled()
  })
})

it('clean local view refresh retains camera and selection while adopting the new revision',async()=>{
 const doc=blank('Shared'),n=node('rectangle',10,10,50,30);doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
 const f=fixture(doc);await f.session.start();await f.session.save();const view={x:-71.25,y:120.5,zoom:1.375};f.editor.set({view,selection:[n.id]})
 const next=structuredClone(doc);next.nodes[n.id].transform[4]=140;const row=f.rows.get(doc.id)!;f.rows.set(doc.id,{...row,revision:2,documentJson:JSON.stringify(next)})
 expect(await f.session.refreshLocalHead(doc.id,2)).toBe(true);expect(f.editor.state.doc.nodes[n.id].transform[4]).toBe(140);expect(f.editor.state.view).toEqual(view);expect(f.editor.state.selection).toEqual([n.id]);expect(f.editor.preservedViewSession).toBe(f.editor.sessionGeneration);expect(f.session.status).toMatchObject({dirty:false,revision:2})
})
it('local view refresh cannot overwrite an edit begun while its read is pending',async()=>{
 const f=fixture();await f.session.start();f.rename('Saved');await f.session.save();const id=f.editor.state.doc.id,row=f.rows.get(id)!,gate=deferred<any>();vi.mocked(f.store.open).mockReturnValueOnce(gate.promise)
 const pending=f.session.refreshLocalHead(id,2);f.rename('Unsaved local edit');gate.resolve({...ok,...row,revision:2,documentJson:JSON.stringify({...f.editor.state.doc,name:'Remote edit'})})
 expect(await pending).toBe(false);expect(f.editor.state.doc.name).toBe('Unsaved local edit');expect(f.session.dirty).toBe(true)
})

it('history restore rejects an older viewed head even after this session saves again', async () => {
  const f = fixture(); await f.session.start(); await f.session.save()
  f.rename('Later saved edit'); await f.session.save()
  expect(await f.session.restoreWorkspace(f.editor.state.doc.id, 1, 1)).toBe(false)
  expect(f.store.restore).not.toHaveBeenCalled()
  expect(f.editor.state.doc.name).toBe('Later saved edit')
})
