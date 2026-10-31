import { expect, test } from 'vitest'
import { canvasLayerFeedback } from './canvas-layer-feedback'
import { Editor } from './engine'
import { blank, node, uid } from './model'

function fixture() {
  const document = blank(), parent = node('group'), child = node('rectangle'), other = node('rectangle')
  parent.children = [child.id]
  document.nodes = { [parent.id]: parent, [child.id]: child, [other.id]: other }
  document.pages[0].children = [parent.id, other.id]
  return { document, parent, child, other, page: document.pages[0].id }
}

test('tree feedback includes inherited locked layers without granting transform handles or changing the document', () => {
  const { document, parent, child, page } = fixture()
  parent.locked = true
  const before = JSON.stringify(document)
  expect(canvasLayerFeedback(document, page, [child.id])).toEqual({
    ids: [child.id], readOnly: true, message: '图层已锁定，仅显示选框',
  })
  expect(JSON.stringify(document)).toBe(before)
})

test('hidden ancestors explain missing canvas feedback and mixed selections retain only visible roots', () => {
  const { document, parent, child, other, page } = fixture()
  parent.visible = false
  expect(canvasLayerFeedback(document, page, [child.id])).toEqual({
    ids: [], readOnly: true, message: '所选图层已隐藏，画布不显示',
  })
  expect(canvasLayerFeedback(document, page, [child.id, other.id])).toEqual({
    ids: [other.id], readOnly: true, message: '部分所选图层已隐藏，仅显示可见图层',
  })
  expect(parent.visible).toBe(false)
})

test('feedback removes selected descendants and rejects targets from another page', () => {
  const { document, parent, child, other, page } = fixture()
  expect(canvasLayerFeedback(document, page, [child.id, parent.id, child.id])).toEqual({
    ids: [parent.id], readOnly: false, message: null,
  })
  document.pages[0].children = [parent.id]
  document.pages.push({ ...document.pages[0], id: uid(), children: [other.id] })
  expect(canvasLayerFeedback(document, page, [other.id])).toEqual({
    ids: [], readOnly: true, message: '所选图层不在当前页面或已不存在',
  })
})

test('reveal requests are scoped, consumed once, and stale acknowledgements cannot consume a newer request', () => {
  const { document, child, other, page } = fixture(), editor = new Editor(document)
  try {
    editor.requestReveal([child.id])
    const first = editor.revealSnapshot()!
    expect(first).toMatchObject({ session: editor.sessionGeneration, documentId: document.id, pageId: page, ids: [child.id] })
    editor.requestReveal([other.id])
    const second = editor.revealSnapshot()!
    expect(second.nonce).toBeGreaterThan(first.nonce)
    expect(editor.consumeReveal(first.nonce)).toBe(false)
    expect(editor.revealSnapshot()).toBe(second)
    expect(editor.consumeReveal(second.nonce)).toBe(true)
    expect(editor.consumeReveal(second.nonce)).toBe(false)
    expect(editor.revealSnapshot()).toBeNull()
    editor.requestReveal([child.id])
    expect(editor.revealSnapshot()!.nonce).toBeGreaterThan(second.nonce)
    expect(editor.load(structuredClone(editor.state.doc), true)).toBe(true)
    expect(editor.revealSnapshot()).toBeNull()
  } finally { editor.dispose() }
  editor.requestReveal([child.id])
  expect(editor.revealSnapshot()).toBeNull()
})
