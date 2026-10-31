import { expect, test } from 'vitest'
import { blank, node, paint, uid } from './model'
import { defaultColorSettings } from './color'
import { Editor } from './engine'
import { emptySystem, installLibrary, publishLibrary } from './design-system'
import { kernelLayout, prepareDocumentForEditing } from './kernel/picking'

test('opening preserves schema 3 HDR and schema 4 authoring, while upgrading legacy files', () => {
  for (const version of [1, 2, 3, 4, 5] as const) {
    const doc = blank()
    doc.schemaVersion = version
    if (version === 3) {
      doc.colorManagement = defaultColorSettings()
      delete doc.rasterProfile
    }
    if (version === 4) doc.designSystem = emptySystem()
    const prepared = prepareDocumentForEditing(doc)
    expect(prepared.schemaVersion).toBe(Math.max(2, version))
    expect(prepared.rasterProfile).toBe(version === 3 ? 'figma' : 'analytic')
    const editor = new Editor()
    editor.load(prepared)
    expect(editor.state.doc).toEqual(prepared)
  }
  const doc = blank(),
    shape = node('rectangle')
  doc.schemaVersion = 4
  shape.fills = [paint('#ff0000', 'angular')]
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  expect(prepareDocumentForEditing(doc).schemaVersion).toBe(4)
})

test('deleting a subtree prunes prototype references in the same undoable edit', () => {
  const doc = blank(),
    frame = node('frame'),
    child = node('rectangle'),
    remaining = node('frame')
  doc.schemaVersion = 4
  frame.children = [child.id]
  doc.nodes = Object.fromEntries([frame, child, remaining].map((n) => [n.id, n]))
  doc.pages[0].children = [frame.id, remaining.id]
  doc.designSystem = emptySystem()
  doc.designSystem.collections.c = { name: 'C', modes: ['default'], defaultMode: 'default' }
  // A variable may have the same ID as a node: node deletion must preserve its actions.
  doc.designSystem.variables[child.id] = {
    name: 'Open',
    collection: 'c',
    kind: 'boolean',
    values: { default: false },
  }
  doc.prototype = {
    startNode: frame.id,
    interactions: {
      [child.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: remaining.id }] }],
      [remaining.id]: [
        {
          trigger: 'click',
          actions: [
            { kind: 'navigate', target: frame.id },
            { kind: 'overlay', target: child.id },
            { kind: 'scroll-to', target: child.id },
            { kind: 'set-variable', target: child.id, value: true },
            { kind: 'back' },
          ],
        },
        { trigger: 'hover', actions: [{ kind: 'overlay', target: frame.id }] },
      ],
    },
  }
  const editor = new Editor(doc),
    before = structuredClone(editor.state.doc)
  editor.select([frame.id])
  editor.remove()
  expect(editor.state.doc.nodes[frame.id], editor.state.message).toBeUndefined()
  expect(editor.state.doc.prototype?.startNode).toBeUndefined()
  expect(editor.state.doc.prototype?.interactions).toEqual({
    [remaining.id]: [
      {
        trigger: 'click',
        actions: [{ kind: 'set-variable', target: child.id, value: true }, { kind: 'back' }],
      },
    ],
  })
  editor.undo()
  expect(editor.state.doc.prototype).toMatchObject(before.prototype!)
  expect(editor.state.doc.nodes[child.id]).toBeDefined()
  editor.redo()
  expect(editor.state.doc.nodes[child.id]).toBeUndefined()
  const after = editor.state.doc
  editor.change('invalid target', (d) => {
    d.prototype!.interactions[remaining.id][0].actions.push({ kind: 'navigate', target: uid() })
  })
  expect(editor.state.doc).toBe(after)
  expect(editor.state.message).toContain('Missing prototype destination')
})

test.each(['property', 'swap-override', 'nested-properties'] as const)(
  'library install and upgrade remap %s references and preserve UUID text literals',
  async (mode) => {
    const doc = blank('Nested library'),
      a = node('frame'),
      b = node('frame'),
      wrapper = node('frame'),
      outer = node('frame'),
      inner = node('frame'),
      nested = node('frame'),
      label = node('text'),
      top = node('frame'),
      outerInstance = node('frame')
    doc.schemaVersion = 4
    for (const n of [a, b, wrapper, outer, top]) {
      n.component = { variants: {}, properties: {} }
      n.componentKey = '$root'
    }
    a.name = 'A'
    b.name = 'B'
    inner.componentKey = 'icon'
    inner.instance = { componentId: a.id, overrides: {}, propertyValues: {} }
    label.componentKey = 'label'
    label.text = 'Default'
    wrapper.children = [inner.id, label.id]
    wrapper.component!.properties = {
      swap: { kind: 'instance-swap', name: 'Icon', targetKey: 'icon', defaultValue: a.id },
      literal: { kind: 'text', name: 'Label', targetKey: 'label', defaultValue: b.id },
    }
    nested.componentKey = 'wrapped'
    nested.instance = { componentId: wrapper.id, overrides: {}, propertyValues: { literal: b.id } }
    if (mode === 'property') nested.instance.propertyValues.swap = b.id
    if (mode === 'swap-override') nested.instance.overrides.icon = { swapComponent: b.id }
    outer.children = [nested.id]
    outerInstance.componentKey = 'outer'
    outerInstance.instance = { componentId: outer.id, overrides: {}, propertyValues: {} }
    if (mode === 'nested-properties')
      outerInstance.instance.overrides.wrapped = { propertyValues: { swap: b.id, literal: b.id } }
    top.children = [outerInstance.id]
    doc.nodes = Object.fromEntries(
      [a, b, wrapper, outer, inner, nested, label, top, outerInstance].map((n) => [n.id, n]),
    )
    doc.pages[0].children = [a.id, b.id, wrapper.id, outer.id, top.id]
    const source = kernelLayout(doc),
      target = new Editor(blank('Consumer'))
    let consumerText = ''
    for (const version of [1, 2]) {
      source.nodes[b.id].fills = [paint(version === 1 ? '#00ff00' : '#0000ff')]
      if (version === 2) {
        const extra = node('text')
        extra.componentKey = 'new-label'
        extra.text = 'New release'
        source.nodes[extra.id] = extra
        source.nodes[wrapper.id].children.push(extra.id)
      }
      const pkg = await publishLibrary(source, version)
      target.change('install', (d) => installLibrary(d, pkg))
      const library = target.state.doc.designSystem?.libraries[source.id]
      expect(library?.version, target.state.message).toBe(version)
      const local =
        mode === 'nested-properties'
          ? target.state.doc.nodes[
              target.state.doc.nodes[library!.nodeMap[outerInstance.id]].children[0]
            ]
          : target.state.doc.nodes[library!.nodeMap[nested.id]]
      expect(local.instance?.propertyValues.literal).toBe(b.id)
      const icon = local.children.map((id) => target.state.doc.nodes[id]).find((n) => n.instance)
      expect(icon?.instance?.componentId).toBe(library!.nodeMap[b.id])
      expect(icon?.fills[0].color).toBe(version === 1 ? '#00ff00' : '#0000ff')
      expect(
        local.children.map((id) => target.state.doc.nodes[id]).find((n) => n.kind === 'text')?.text,
      ).toBe(b.id)
      if (version === 1) {
        const instance = target.insertComponent(library!.nodeMap[outer.id])
        const nestedInstance = target.state.doc.nodes[target.state.doc.nodes[instance].children[0]]
        consumerText = nestedInstance.children.find(
          (id) => target.state.doc.nodes[id].kind === 'text',
        )!
        target.update([consumerText], { text: 'Consumer override' })
      } else {
        expect(local.children.some((id) => target.state.doc.nodes[id].text === 'New release')).toBe(
          true,
        )
        expect(target.state.doc.nodes[consumerText].text).toBe('Consumer override')
      }
    }
    target.undo()
    expect(target.state.doc.designSystem?.libraries[source.id].version).toBe(1)
    target.redo()
    expect(target.state.doc.designSystem?.libraries[source.id].version).toBe(2)
  },
)
