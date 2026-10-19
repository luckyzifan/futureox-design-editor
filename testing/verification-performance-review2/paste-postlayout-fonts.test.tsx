import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Editor } from '../../frontend/design-client/src/engine'
import { blank, node, defaultTextStyle, validateStructure } from '../../frontend/design-client/src/model'
import { stampKeys } from '../../frontend/design-client/src/components'
import { activateDocumentFonts, kernelLayout, kernelTextLayout } from '../../frontend/design-client/src/kernel/picking'
import { planPasteOverSelection } from '../../frontend/design-client/src/paste-over-selection'
import { dispatchEditorCommand } from '../../frontend/design-client/src/editor-commands'
import { cloneValue } from '../../frontend/design-client/src/draft'

test('a valid preflight whose instance expands beyond depth limit rejects atomically and restores actual font environment', async()=>{
  const destination=blank('Derived depth failure')
  const parents=Array.from({length:64},()=>node('frame',0,0,100,100))
  const target=node('rectangle',0,0,20,20)
  parents.forEach((n,i)=>{n.fills=[];n.children=[i+1<parents.length?parents[i+1].id:target.id];destination.nodes[n.id]=n})
  destination.nodes[target.id]=target;destination.pages[0].children=[parents[0].id]
  const editor=new Editor(destination);editor.select([target.id])
  try {
    const source=blank('Foreign-font component'),master=node('frame',0,0,50,50),text=node('text',0,0,50,30)
    source.fonts={foreign:{family:'Foreign',data:readFileSync(new URL('../../frontend/design-client/public/fonts/NotoSansSC.ttf',import.meta.url)).toString('base64')}}
    text.text='字体117';text.textStyle={...defaultTextStyle(),fontId:'foreign'}
    master.component={variants:{},properties:{}};master.children=[text.id]
    source.nodes[master.id]=master;source.nodes[text.id]=text;source.pages[0].children=[master.id];stampKeys(source,master.id)
    const serialized=JSON.stringify({format:'forma-nodes',version:1,document:source,roots:[master.id]})
    const before=editor.state.doc,snapshot=structuredClone(before),selection=[...editor.state.selection]
    activateDocumentFonts(before);const expected=kernelTextLayout(text)
    expect(expected.glyphs.length).toBeGreaterThan(0)
    const plan=planPasteOverSelection(before,editor.state.page,selection,serialized,'figma-like')
    expect(plan.document.nodes[plan.selection[0]].children).toHaveLength(0)
    expect(()=>validateStructure(plan.document)).not.toThrow()
    // Real negative witness: derived layout expands the instance, loads foreign
    // fonts and then fails depth validation. Without restoration, font lookup differs.
    expect(()=>validateStructure(kernelLayout(plan.document,before))).toThrow(/64|嵌套|depth/i)
    const leaked=kernelTextLayout(text)
    expect(leaked.glyphs.length).toBeGreaterThan(0);expect(leaked).not.toEqual(expected)
    activateDocumentFonts(before);expect(kernelTextLayout(text)).toEqual(expected)
    vi.stubGlobal('navigator',{clipboard:{readText:async()=>`FORMA-NODES-V1\n${serialized}`}})
    await dispatchEditorCommand(editor,'paste-over-selection',{shortcutProfile:'figma-like'})
    expect(editor.state.doc).toBe(before);expect(before).toEqual(snapshot)
    expect(editor.state.selection).toEqual(selection);expect(editor.canUndo).toBe(false)
    expect(editor.state.message).toMatch(/64|嵌套|depth/i)
    expect(kernelTextLayout(text)).toEqual(expected)
  } finally { editor.dispose();vi.unstubAllGlobals() }
})

test('candidate detachment preserves signed zero and typed arrays without JSON conversion',()=>{
  const value={number:-0,values:new Float32Array([-0,1.25]),nested:{width:3.5}}
  const copy=cloneValue(value)
  expect(Object.is(copy.number,-0)).toBe(true);expect(Object.is(copy.values[0],-0)).toBe(true)
  expect(copy.values).toBeInstanceOf(Float32Array);expect(copy.values).not.toBe(value.values)
  expect(copy).toEqual(value);expect(copy.nested).not.toBe(value.nested)
})
