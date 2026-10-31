import { expect, test } from 'vitest'
import { blank, node } from './model'
import { declareSlot, assignSlot } from './component-slots'
import { captureOverrides, remapInstance } from './components'
function fixture() {
  const d = blank(), main = node('frame'), host = node('frame'), fallback = node('text'), instance = node('frame'), generated = node('frame'), content = node('frame'), child = node('text')
  main.component = { variants: {}, properties: {} }; main.children = [host.id]; host.children = [fallback.id]; host.componentKey = 'body'
  instance.instance = { componentId: main.id, overrides: {}, propertyValues: {} }; instance.children = [generated.id]
  generated.instanceOrigin = { owner: instance.id, key: 'body', source: host.id }
  content.children = [child.id]
  for (const n of [main, host, fallback, instance, generated, content, child]) d.nodes[n.id] = n
  d.pages[0].children = [main.id, instance.id, content.id]
  declareSlot(d, host.id, 'Body', 'body')
  return { d, main, host, fallback, instance, generated, content, child }
}
test('declares fallback container and moves arbitrary subtree with stable IDs', () => {
  const { d, host, fallback, instance, generated, content, child } = fixture()
  const before = structuredClone(d)
  assignSlot(d, instance.id, 'body', [content.id]); captureOverrides(before, d)
  expect(host.children).toEqual([fallback.id]); expect(content.children).toEqual([child.id])
  expect(generated.children).toEqual([content.id]); expect(d.pages[0].children).not.toContain(content.id)
  expect(instance.instance!.slotContents).toEqual({ body: [content.id] })
  assignSlot(d, instance.id, 'body', null)
  expect(d.pages[0].children).toContain(content.id); expect(instance.instance!.slotContents).toEqual({})
})
test('rejects missing IDs, source ancestry cycles, locks and overlapping roots', () => {
  for (const type of ['missing', 'cycle', 'lock', 'overlap']) {
    const { d, main, instance, content, child } = fixture()
    if (type === 'lock') child.locked = true
    const ids = type === 'missing' ? ['missing'] : type === 'cycle' ? [main.id] : type === 'overlap' ? [content.id, child.id] : [content.id]
    expect(() => assignSlot(d, instance.id, 'body', ids)).toThrow()
  }
})
test('variant remap preserves slot identity, rejects dropped assignment', () => {
  const { d, main, instance, content } = fixture(); assignSlot(d, instance.id, 'body', [content.id])
  const variant = structuredClone(main); variant.id = 'variant'; d.nodes[variant.id] = variant
  expect(remapInstance(d, instance.instance!, variant.id).slotContents).toEqual({ body: [content.id] })
  variant.component!.slots = {}
  expect(() => remapInstance(d, instance.instance!, variant.id)).toThrow(/matching content slot/)
})
