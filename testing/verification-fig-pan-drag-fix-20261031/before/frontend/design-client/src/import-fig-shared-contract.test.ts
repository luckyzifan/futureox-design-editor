import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { importFig } from './import-fig'
import { validateDocument } from './model'
import { Editor } from './engine'
const bytes = new Uint8Array(readFileSync(new URL('../../../testing/fixtures/design/fig-interop-v106.fig',import.meta.url)))
test('the same real-v106-schema corpus executes image, boolean and component semantics through Editor/WASM',()=>{
  const imported=importFig(bytes)
  validateDocument(imported.document)
  const named=(name:string)=>Object.values(imported.document.nodes).find(n=>n.name===name)!
  expect(named('XOR').booleanOperation).toBe('exclude')
  expect(named('Disabled gradient').blend).toBe('pass-through')
  expect(named('Disabled gradient').fills[0]).toMatchObject({visible:false,blend:'linear-burn',opacity:.5})
  expect(named('Disabled gradient').fills[0].stops[0].color).toBe('color(srgb 0.125 0.25 0.5 / 0.125)')
  for(const [name,fit] of [['STRETCH','stretch'],['FIT','contain'],['FILL','cover'],['TILE','cover']]) {
    expect(named(name).fills[0].fit).toBe(fit);expect(named(name).fills[0].image).toMatch(/^data:image\/png;base64,/)
    expect(!!named(name).fills[0].tile).toBe(name==='TILE')
  }
  const editor=new Editor(imported.document)
  try {
    const children=Object.values(editor.state.doc.nodes).filter(n=>n.instanceOrigin && n.kind==='text')
    expect(children.some(n=>n.text==='Edited'&&!n.visible)).toBe(true)
    const id=named('Disabled gradient').id
    editor.change('Enable imported paint',d=>{d.nodes[id].fills[0].visible=true})
    expect(editor.state.doc.nodes[id].fills[0].visible).toBe(true)
    editor.undo();expect(editor.state.doc.nodes[id].fills[0].visible).toBe(false)
    editor.redo();expect(editor.state.doc.nodes[id].fills[0].visible).toBe(true)
  } finally {editor.dispose()}
})
