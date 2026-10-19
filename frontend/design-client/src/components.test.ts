/// <reference types="node" />
import { beforeAll, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking, kernelLayout } from './kernel/picking'
import { componentFixture, originNode } from './component-fixtures'
import { Editor } from './engine'
import { blank, node, paint, validateDocument } from './model'
import { family } from './components'
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
function setup() {
  const { doc, ids } = componentFixture()
  return { e: new Editor(doc), ids }
}
test('master edits propagate while text overrides remain local', () => {
  const { e, ids } = setup()
  e.setComponentProperty(ids.a, ids.title, '提交')
  e.update([ids.label], { text: '默认更新' })
  expect(originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.label].componentKey!).text).toBe(
    '提交',
  )
  expect(originNode(e.state.doc, ids.b, e.state.doc.nodes[ids.label].componentKey!).text).toBe(
    '默认更新',
  )
  expect(e.state.doc.nodes[ids.button].component!.properties[ids.title].defaultValue).toBe(
    '默认更新',
  )
})
test('generic inspector edits capture overrides and reset restores the main style', () => {
  const { e, ids } = setup()
  const child = originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.label].componentKey!)
  e.update([child.id], { fills: [paint('#ff0000')] })
  e.update([ids.label], { fills: [paint('#0000ff')] })
  expect(e.state.doc.nodes[child.id].fills[0].color).toBe('#ff0000')
  e.resetInstance(child.id)
  expect(e.state.doc.nodes[child.id].fills[0].color).toBe('#0000ff')
})
test('boolean and nested swap properties affect layout and rendered references', () => {
  const { e, ids } = setup()
  const width = e.state.doc.nodes[ids.a].width
  e.setComponentProperty(ids.a, ids.show, false)
  expect(e.state.doc.nodes[ids.a].width).toBeLessThan(width)
  e.setComponentProperty(ids.a, ids.icon, ids.iconB)
  const slot = originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.slot].componentKey!)
  expect(slot.instance!.componentId).toBe(ids.iconB)
  e.undo()
  expect(
    originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.slot].componentKey!).instance!.componentId,
  ).toBe(ids.iconA)
})
test('variants keep overrides, stable descendant IDs and placement', () => {
  const { e, ids } = setup()
  e.setComponentProperty(ids.a, ids.title, '实例覆盖')
  const key = e.state.doc.nodes[ids.label].componentKey!,
    before = originNode(e.state.doc, ids.a, key).id
  const variant = e.addVariant(ids.button)
  expect(e.state.doc.nodes[variant].component).toBeTruthy()
  e.update([variant], { fills: [paint('#ffccee')] })
  e.swapInstance(ids.a, variant)
  expect(e.state.doc.nodes[ids.a].instance!.componentId).toBe(variant)
  expect(originNode(e.state.doc, ids.a, key).id).toBe(before)
  expect(e.state.doc.nodes[before].text).toBe('实例覆盖')
  expect(e.state.doc.nodes[ids.a].transform[4]).toBe(350)
  expect(e.state.doc.nodes[ids.a].fills[0].color).toBe('#ffccee')
  e.undo()
  expect(e.state.doc.nodes[ids.a].instance!.componentId).toBe(ids.button)
  expect(family(e.state.doc, variant)).toBeTruthy()
})
test('master structure additions and removal do not leave unreachable nodes', () => {
  const { e, ids } = setup()
  const labelKey = e.state.doc.nodes[ids.label].componentKey!,
    old = originNode(e.state.doc, ids.a, labelKey).id
  e.select([ids.label])
  e.remove()
  expect(e.state.doc.nodes[old]).toBeUndefined()
  expect(() => validateDocument(e.state.doc)).not.toThrow()
  e.undo()
  expect(e.state.doc.nodes[old]).toBeTruthy()
  const added = e.add('rectangle', { x: 0, y: 0, width: 12, height: 12 }, ids.button)
  expect(originNode(e.state.doc, ids.a, added)).toBeTruthy()
})
test('instance structure edits are rejected atomically; deleting a child hides it', () => {
  const { e, ids } = setup()
  const before = e.state.doc
  e.add('rectangle', { x: 0, y: 0, width: 5, height: 5 }, ids.a)
  expect(e.state.doc).toBe(before)
  const child = originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.label].componentKey!)
  e.select([child.id])
  e.remove()
  expect(e.state.doc.nodes[child.id].visible).toBe(false)
  expect(e.state.doc.nodes[ids.label].visible).toBe(true)
})
test('detach stops propagation and undo restores links', () => {
  const { e, ids } = setup()
  e.detachInstance(ids.a)
  expect(e.state.doc.nodes[ids.a].instance).toBeUndefined()
  expect(Object.values(e.state.doc.nodes).some((n) => n.instanceOrigin?.owner === ids.a)).toBe(
    false,
  )
  e.undo()
  expect(e.state.doc.nodes[ids.a].instance).toBeTruthy()
})
test('deleting a master preserves appearances and undo restores all references', () => {
  const { e, ids } = setup()
  e.select([ids.iconA])
  e.remove()
  expect(e.state.doc.nodes[ids.iconA]).toBeUndefined()
  expect(e.state.doc.nodes[ids.slot].instance).toBeUndefined()
  expect(e.state.doc.nodes[ids.a].instance).toBeTruthy()
  expect(() => validateDocument(e.state.doc)).not.toThrow()
  e.undo()
  expect(e.state.doc.nodes[ids.iconA].component).toBeTruthy()
  expect(e.state.doc.nodes[ids.slot].instance).toBeTruthy()
})
test('duplicate masters creates instances and cross-document paste imports dependencies', () => {
  const { e, ids } = setup()
  e.select([ids.button])
  e.duplicate()
  expect(e.state.doc.nodes[e.state.selection[0]].instance!.componentId).toBe(ids.button)
  e.select([ids.a])
  e.copy()
  e.load(blank('目标文件'))
  e.paste()
  expect(e.state.doc.nodes[e.state.selection[0]].instance!.componentId).toBe(ids.button)
  expect(e.state.doc.nodes[ids.iconA].component).toBeTruthy()
  expect(() => validateDocument(e.state.doc)).not.toThrow()
})
test('component serialization is idempotent and returns to the same pixels after reload', () => {
  const { e } = setup()
  const saved = JSON.stringify(e.state.doc)
  e.load(JSON.parse(saved))
  expect(JSON.stringify(e.state.doc)).toBe(saved)
  expect(JSON.stringify(kernelLayout(e.state.doc))).toBe(saved)
})
test('circular component dependencies fail without replacing the current document', () => {
  const { e, ids } = setup()
  const before = e.state.doc
  e.insertComponent(ids.button, { x: 0, y: 0 }, ids.button)
  expect(e.state.doc).toBe(before)
  expect(e.state.message).toMatch(/Cyclic/)
})

test('variant families and non-default nested swaps survive cross-document paste', () => {
  const { e, ids } = setup()
  const variant = e.addVariant(ids.button)
  e.swapInstance(ids.a, variant)
  e.setComponentProperty(ids.a, ids.icon, ids.iconB)
  e.select([ids.a])
  e.copy()
  e.load(blank('跨文件变体'))
  e.paste()
  const inserted = e.state.doc.nodes[e.state.selection[0]]
  expect(inserted.instance?.componentId).toBe(variant)
  expect(family(e.state.doc, variant)).toBeTruthy()
  expect(e.state.doc.nodes[ids.iconB]?.component).toBeTruthy()
  expect(() => validateDocument(e.state.doc)).not.toThrow()
})
test('copying an instance child creates an independently editable layer', () => {
  const { e, ids } = setup()
  const label = originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.label].componentKey!)
  e.select([label.id])
  e.copy()
  e.paste()
  const pasted = e.state.doc.nodes[e.state.selection[0]]
  expect(pasted.instanceOrigin).toBeUndefined()
  expect(pasted.text).toBe(label.text)
})
test('swapping independent components remaps overrides by layer names and reset stays reset', () => {
  const { e, ids } = setup()
  const d = e.state.doc,
    other = node('frame', 200, 300, 200, 60),
    label = node('text', 10, 10, 100, 30)
  label.name = '标题'
  label.text = '另一个默认'
  other.children = [label.id]
  e.change('添加独立组件', (next) => {
    next.nodes[other.id] = other
    next.nodes[label.id] = label
    next.pages[0].children.push(other.id)
  })
  e.select([other.id])
  const target = e.createComponent()
  const old = originNode(e.state.doc, ids.a, d.nodes[ids.label].componentKey!)
  e.update([old.id], { fills: [paint('#ff0000')] })
  e.swapInstance(ids.a, target)
  const current = originNode(e.state.doc, ids.a, e.state.doc.nodes[label.id].componentKey!)
  expect(current.fills[0].color).toBe('#ff0000')
  e.resetInstance(current.id)
  e.swapInstance(ids.a, ids.button)
  expect(originNode(e.state.doc, ids.a, d.nodes[ids.label].componentKey!).fills[0].color).toBe(
    d.nodes[ids.label].fills[0].color,
  )
})

test('editing one nested property does not freeze another property inherited from the main component', () => {
  const { e, ids } = setup()
  const star = e.state.doc.nodes[ids.iconA].children[0]
  e.exposeComponentProperty(star, 'boolean', '显示星形')
  const text = e.add('text', { x: 0, y: 0, width: 30, height: 20 }, ids.iconA)
  e.update([text], { name: '图标文字', text: '默认' })
  e.exposeComponentProperty(text, 'text', '图标文案')
  const props = e.state.doc.nodes[ids.iconA].component!.properties,
    show = Object.keys(props).find((id) => props[id].name === '显示星形')!,
    caption = Object.keys(props).find((id) => props[id].name === '图标文案')!
  e.setComponentProperty(ids.slot, show, true)
  const nested = originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.slot].componentKey!)
  e.setComponentProperty(nested.id, caption, '局部')
  e.setComponentProperty(ids.slot, show, false)
  const prefix = e.state.doc.nodes[ids.slot].componentKey!
  expect(
    originNode(e.state.doc, ids.a, `${prefix}/${e.state.doc.nodes[star].componentKey!}`).visible,
  ).toBe(false)
  expect(
    originNode(e.state.doc, ids.a, `${prefix}/${e.state.doc.nodes[text].componentKey || text}`)
      .text,
  ).toBe('局部')
})

test('deleting an override-selected nested component detaches only affected instances and keeps appearance', () => {
  const { e, ids } = setup()
  e.setComponentProperty(ids.a, ids.icon, ids.iconB)
  const beforeWidth = e.state.doc.nodes[ids.a].width
  e.select([ids.iconB])
  e.remove()
  expect(e.state.doc.nodes[ids.iconB]).toBeUndefined()
  expect(e.state.doc.nodes[ids.a].instance).toBeUndefined()
  expect(e.state.doc.nodes[ids.b].instance).toBeTruthy()
  expect(e.state.doc.nodes[ids.a].width).toBe(beforeWidth)
  expect(() => validateDocument(e.state.doc)).not.toThrow()
  e.undo()
  expect(e.state.doc.nodes[ids.a].instance?.propertyValues[ids.icon]).toBe(ids.iconB)
})

test('removing a default nested master does not erase an alternate swap override', () => {
  const { e, ids } = setup()
  e.setComponentProperty(ids.a, ids.icon, ids.iconB)
  e.select([ids.iconA])
  e.remove()
  expect(e.state.doc.nodes[ids.a].instance).toBeUndefined()
  expect(e.state.doc.nodes[ids.b].instance).toBeTruthy()
  const descendants: string[] = []
  const walk = (id: string) => {
    descendants.push(id)
    e.state.doc.nodes[id].children.forEach(walk)
  }
  walk(ids.a)
  expect(descendants.some((id) => e.state.doc.nodes[id].kind === 'ellipse')).toBe(true)
  expect(() => validateDocument(e.state.doc)).not.toThrow()
})
