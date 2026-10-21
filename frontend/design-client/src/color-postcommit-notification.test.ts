import { afterEach, expect, test, vi } from 'vitest'
import { Editor, type EditorEditEvent } from './engine'
import { blank, node } from './model'
import { ColorEditSession } from './color-edit-session'
const editors: Editor[] = []
afterEach(() => { vi.restoreAllMocks(); editors.splice(0).forEach(e => e.dispose()); vi.unstubAllGlobals() })
test.each([false, true])('color accepted commit finishes its lease despite subscriber throw (same-ID replacement=%s)', async replace => {
 const d=blank(), n=node('rectangle');d.nodes[n.id]=n;d.pages[0].children=[n.id]
 const e=new Editor(d);editors.push(e);e.select([n.id])
 const session=e.sessionGeneration, revision=e.state.version, events:EditorEditEvent[]=[], errors:unknown[]=[]
 const failure=new Error('color postcommit subscriber');vi.stubGlobal('reportError',(error:unknown)=>errors.push(error))
 let armed=false, entered=false, newer:ColorEditSession|null=null
 e.subscribe(()=>{if(!armed||entered||e.state.version!==revision+1)return;entered=true;if(replace){const replacement=structuredClone(d);e.load(replacement);e.select([n.id]);newer=ColorEditSession.open(e,{kind:'solid-fill',nodeId:n.id,fillIndex:0,fillId:n.fills[0].id})}throw failure})
 const color=ColorEditSession.open(e,{kind:'solid-fill',nodeId:n.id,fillIndex:0,fillId:n.fills[0].id})!
 color.update({color:'#abcdef'});e.subscribeEdits(event=>events.push(event));armed=true
 expect(()=>expect(color.commit()).toBe(true)).not.toThrow()
 expect(entered).toBe(true);expect(color.active).toBe(false);expect(color.commit()).toBe(true)
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({documentId:d.id,session,revision:revision+1})
 if(replace){expect(e.sessionGeneration).toBe(session+1);expect(newer!.active).toBe(true);color.dispose();expect(newer!.active).toBe(true);newer!.cancel()}
 else {expect(e.state.doc.nodes[n.id].fills[0].color).toBe('#abcdef');expect(e.canUndo).toBe(true);e.undo();expect(e.state.doc.nodes[n.id].fills[0].color).toBe(n.fills[0].color);e.redo();expect(e.state.doc.nodes[n.id].fills[0].color).toBe('#abcdef')}
 await Promise.resolve();expect(errors).toEqual([failure])
})
