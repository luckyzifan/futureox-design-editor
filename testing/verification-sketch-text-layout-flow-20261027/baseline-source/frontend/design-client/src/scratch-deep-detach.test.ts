/// <reference types="node" />
import { beforeAll, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking } from './kernel/picking'
import { componentFixture, originNode } from './component-fixtures'
import { Editor } from './engine'

beforeAll(async () => {
  await initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  })
})

test('detaching a parent preserves nested instance appearance and undo restores component links', () => {
  const { doc, ids } = componentFixture()
  const editor = new Editor(doc)
  try {
    const slotKey = editor.state.doc.nodes[ids.slot].componentKey!
    const slot = originNode(editor.state.doc, ids.a, slotKey)
    const before = structuredClone(editor.state.doc)
    expect(slot.instance).toBeDefined()
    expect(slot.instanceOrigin?.owner).toBe(ids.a)
    editor.detachInstance(ids.a)
    expect(editor.state.doc.nodes[ids.a].instance).toBeUndefined()
    expect(Object.values(editor.state.doc.nodes).filter(n => n.instanceOrigin?.owner === ids.a)).toHaveLength(0)
    expect(editor.state.doc.nodes[ids.b].instance?.componentId).toBe(ids.button)
    const descendants = (id: string): string[] => [id, ...editor.state.doc.nodes[id].children.flatMap(descendants)]
    const detached = descendants(ids.a).map(id => editor.state.doc.nodes[id])
    expect(detached.length).toBeGreaterThan(2)
    expect(detached.some(n => n.kind === 'star')).toBe(true)
    expect(detached.some(n => n.kind === 'text' && n.text === '继续')).toBe(true)
    editor.undo()
    expect(editor.state.doc).toEqual(before)
    editor.redo()
    expect(editor.state.doc.nodes[ids.a].instance).toBeUndefined()
    expect(descendants(ids.a).map(id => editor.state.doc.nodes[id].kind)).toEqual(detached.map(n => n.kind))
  } finally { editor.dispose() }
})
