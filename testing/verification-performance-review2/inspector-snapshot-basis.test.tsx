// Independent exact prior-component/current-component parent+child edit comparison.
// @ts-expect-error test runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from '../../frontend/design-client/src/engine'
import { blank, node, stroke } from '../../frontend/design-client/src/model'
import { MultiSelectionInspector } from '../../frontend/design-client/src/MultiSelectionInspector'
import { MultiSelectionInspector as BeforeInspector } from './fixtures/MultiSelectionInspector.before'
import { PendingEditContext } from '../../frontend/design-client/src/pending-edit-context'
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  return dom
})
bootstrap.window.close()

let dom: any, root: Root, mount: HTMLDivElement
const editors: Editor[] = []
let errors: unknown[][]
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  errors = []
  const original = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); original(...args) })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editors.splice(0).forEach(editor => editor.dispose())
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  expect(errors).toEqual([])
})

function field(label: string) { return mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)! }
function enter(label: string, value: string) {
  const input = field(label)
  expect(input).not.toBeNull()
  act(() => input.focus())
  act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  act(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}


for (const kind of ['frame', 'group'] as const) for (const reverse of [false, true]) test(`${kind} parent+child ${reverse ? 'child-first' : 'parent-first'} edits preserve the exact old snapshot-unit basis`, async () => {
  const doc=blank('Ancestor and descendant selected'), outer=node('frame',20,40,1000,1000), parent=node(kind,12,18,180,140), child=node('rectangle',10,20,40,30), sibling=node('rectangle',100,60,30,20)
  outer.transform=[0,-2,-2,0,20,40]; parent.transform=[1,.25,.1,1.5,12,18]
  parent.children=[child.id,sibling.id]; outer.children=[parent.id]; doc.pages[0].children=[outer.id]
  for(const n of [outer,parent,child,sibling]) { n.strokes=[stroke()]; doc.nodes[n.id]=n }
  const ids=reverse?[child.id,parent.id]:[parent.id,child.id]
  const oldEditor=new Editor(structuredClone(doc)), currentEditor=new Editor(structuredClone(doc)); editors.push(oldEditor,currentEditor)
  oldEditor.select(ids);currentEditor.select(ids)
  const renderPanel=async (editor:Editor, Before:boolean) => {
    const Panel=Before?BeforeInspector:MultiSelectionInspector
    await act(async()=>root.render(<PendingEditContext.Provider value={editor}><Panel editor={editor} nodes={ids.map(id=>editor.state.doc.nodes[id])}/></PendingEditContext.Provider>))
  }
  for(const [label,value] of [['W','+=12'],['H','210'],['X','+=7'],['描边 1粗细','9']] as const) {
    const prior=currentEditor.state.doc
    await renderPanel(oldEditor,true);enter(label,value)
    await renderPanel(currentEditor,false);enter(label,value)
    expect(currentEditor.state.doc).toEqual(oldEditor.state.doc)
    expect(currentEditor.state.doc).not.toEqual(prior)
    const changed=currentEditor.state.doc
    act(()=>currentEditor.undo()); expect(currentEditor.state.doc).toEqual(prior)
    act(()=>currentEditor.redo()); expect(currentEditor.state.doc).toEqual(changed)
  }
  expect(currentEditor.state.doc.nodes[parent.id].transform).not.toEqual(doc.nodes[parent.id].transform)
  expect(currentEditor.state.doc.nodes[child.id]).not.toEqual(doc.nodes[child.id])
})
