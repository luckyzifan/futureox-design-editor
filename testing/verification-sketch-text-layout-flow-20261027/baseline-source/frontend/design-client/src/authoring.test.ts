import { zstdCompressSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { blank, node, paint, uid } from './model'
import { Editor } from './engine'
import { emptySystem, installLibrary, publishLibrary, verifyLibrary } from './design-system'
import { initialPrototype, prototypeEvent, prototypeDocument } from './prototype'
import { kernelLayout, kernelTextLayout } from './kernel/picking'
import { styleTextRange, replaceText } from './text'
import { decodeFig, decodeKiwi, importFig } from './import-fig'
import { encodeBinarySchema, compileSchema, type Schema } from 'kiwi-schema'
import { deflateSync, zipSync } from 'fflate'

test('editable Boolean retains operands and responds to a source edit and undo', async () => {
  const d = blank(),
    a = node('ellipse', 0, 0, 100, 100),
    b = node('ellipse', 40, 0, 100, 100)
  d.nodes = { [a.id]: a, [b.id]: b }
  d.pages[0].children = [a.id, b.id]
  const e = new Editor(d)
  e.select([a.id, b.id])
  await e.geometry('subtract')
  const id = e.state.selection[0],
    group = e.state.doc.nodes[id]
  expect(group.booleanOperation, e.state.message).toBe('subtract')
  expect(group.children).toEqual([a.id, b.id])
  expect(group.network!.edges.some((e) => e.c1)).toBe(true)
  const old = JSON.stringify(group.network)
  e.update(
    [b.id],
    (n) => {
      n.transform[4] = 60
    },
    '移动操作数',
  )
  expect(JSON.stringify(e.state.doc.nodes[id].network)).not.toBe(old)
  e.undo()
  expect(JSON.stringify(e.state.doc.nodes[id].network)).toBe(old)
  e.undo()
  expect(e.state.doc.pages[0].children).toEqual([a.id, b.id])
})
test('typed aliases and shared style changes propagate and undo atomically', () => {
  const d = blank(),
    n = node('rectangle')
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  const e = new Editor(d)
  e.change('添加主题', (d) => {
    const s = (d.designSystem = emptySystem())
    s.collections.theme = { name: 'Theme', modes: ['day', 'night'], defaultMode: 'day' }
    s.variables.brand = {
      name: 'Brand',
      collection: 'theme',
      kind: 'color',
      values: { day: '#ff0000', night: '#0000ff' },
    }
    s.variables.alias = {
      name: 'Alias',
      collection: 'theme',
      kind: 'color',
      values: { day: { alias: 'brand' }, night: { alias: 'brand' } },
    }
    d.nodes[n.id].bindings = { 'fills.0.color': 'alias' }
  })
  expect(e.state.doc.nodes[n.id].fills[0].color).toBe('#ff0000')
  e.change('夜间', (d) => {
    d.designSystem!.activeModes.theme = 'night'
  })
  expect(e.state.doc.nodes[n.id].fills[0].color).toBe('#0000ff')
  e.undo()
  expect(e.state.doc.nodes[n.id].fills[0].color).toBe('#ff0000')
  const before = e.state.doc
  e.change('循环', (d) => {
    d.designSystem!.variables.brand.values.day = { alias: 'alias' }
  })
  expect(e.state.doc).toBe(before)
})
test('rich text range edits preserve graphemes, colors, decorations and links', () => {
  const n = node('text')
  n.text = 'A中文 B'
  styleTextRange(n, 1, 3, { color: '#ff0000', underline: true, link: 'https://example.com' })
  replaceText(n, 'A中文字符 B')
  expect(n.textRuns?.some((r) => r.color === '#ff0000')).toBe(true)
  const layout = kernelTextLayout(n)
  expect(layout.spans.some((s) => s.color === '#ff0000')).toBe(true)
  n.text = 'e\u0301'
  n.textRuns = []
  expect(() => styleTextRange(n, 0, 1, { underline: true })).toThrow()
})
test('library upgrades keep component identity and consuming instance overrides', async () => {
  const source = blank('Library'),
    button = node('frame'),
    label = node('text')
  label.text = 'Default'
  button.children = [label.id]
  button.component = { variants: {}, properties: {} }
  button.componentKey = '$root'
  label.componentKey = 'label'
  source.nodes = { [button.id]: button, [label.id]: label }
  source.pages[0].children = [button.id]
  const one = await publishLibrary(source, 1),
    target = new Editor(blank('Consumer'))
  target.change('安装', (d) => installLibrary(d, one))
  const local = target.state.doc.designSystem!.libraries[source.id].nodeMap[button.id]
  target.insertComponent(local)
  const instance = target.state.selection[0],
    child = target.state.doc.nodes[instance].children[0]
  target.update(
    [child],
    (n) => {
      n.text = 'Override'
    },
    '覆盖文字',
  )
  source.nodes[button.id].fills = [paint('#00ff00')]
  const two = await publishLibrary(source, 2)
  target.change('升级', (d) => installLibrary(d, two))
  expect(target.state.doc.nodes[instance].fills[0].color).toBe('#00ff00')
  expect(target.state.doc.nodes[child].text).toBe('Override')
  expect(target.state.doc.designSystem!.libraries[source.id].nodeMap[button.id]).toBe(local)
  await expect(verifyLibrary({ ...two, digest: 'bad' })).rejects.toThrow('摘要')
  await expect(verifyLibrary({...two,id:'__proto__'})).rejects.toThrow('标识')
})
test('prototype navigation, overlay, back and temporary conditional variables', () => {
  const d = blank(),
    a = node('frame'),
    b = node('frame')
  d.nodes = { [a.id]: a, [b.id]: b }
  d.pages[0].children = [a.id, b.id]
  const s = (d.designSystem = emptySystem())
  s.collections.c = { name: 'C', modes: ['default'], defaultMode: 'default' }
  s.variables.open = { name: 'Open', collection: 'c', kind: 'boolean', values: { default: false } }
  d.prototype = {
    startNode: a.id,
    interactions: {
      [a.id]: [
        {
          trigger: 'click',
          actions: [
            { kind: 'set-variable', target: 'open', value: true },
            { kind: 'navigate', target: b.id },
          ],
        },
      ],
      [b.id]: [
        {
          trigger: 'click',
          condition: { variable: 'open', equals: true },
          actions: [{ kind: 'overlay', target: a.id }],
        },
      ],
    },
  }
  const first = initialPrototype(d),
    next = prototypeEvent(d, first, a.id, 'click')
  expect(next.current).toBe(b.id)
  expect(next.history).toEqual([a.id])
  expect(prototypeEvent(d, next, b.id, 'click').overlays).toEqual([a.id])
  expect(prototypeDocument(d, next).designSystem!.variables.open.values.default).toBe(true)
  expect(d.designSystem.variables.open.values.default).toBe(false)
})
test('layout island edits preserve unrelated root identity and full resolve equivalence', () => {
  const d = blank(),
    a = node('frame'),
    b = node('frame'),
    x = node('rectangle'),
    y = node('rectangle')
  a.children = [x.id]
  b.children = [y.id]
  a.layout = {
    mode: 'horizontal',
    gap: 12,
    lineGap: 12,
    padding: [0, 0, 0, 0],
    wrap: false,
    justify: 'start',
    align: 'start',
    columns: 3,
    fillRows: false,
  }
  b.layout = { ...a.layout }
  d.nodes = Object.fromEntries([a, b, x, y].map((n) => [n.id, n]))
  d.pages[0].children = [a.id, b.id]
  const e = new Editor(d),
    old = e.state.doc.nodes[b.id]
  e.update(
    [x.id],
    (n) => {
      n.width = 321
    },
    '修改尺寸',
  )
  expect(e.state.doc.nodes[b.id]).toBe(old)
  expect(kernelLayout(e.state.doc)).toEqual(e.state.doc)
})
test('FIG embedded schema is interpreted without executing field names', () => {
  const schema: Schema = {
    package: null,
    definitions: [
      {
        name: 'Message',
        kind: 'MESSAGE',
        line: 0,
        column: 0,
        fields: [
          {
            name: 'name',
            type: 'string',
            value: 1,
            isArray: false,
            isDeprecated: false,
            line: 0,
            column: 0,
          },
        ],
      },
    ],
  }
  const raw = compileSchema(schema).encodeMessage({ name: 'hello' }),
    encoded = encodeBinarySchema(schema),
    parts = [deflateSync(encoded), deflateSync(raw)]
  const fig = new Uint8Array(12 + parts.reduce((n, p) => n + p.length + 4, 0))
  fig.set(new TextEncoder().encode('fig-kiwi'))
  new DataView(fig.buffer).setUint32(8, 15, true)
  let at = 12
  for (const p of parts) {
    new DataView(fig.buffer).setUint32(at, p.length, true)
    at += 4
    fig.set(p, at)
    at += p.length
  }
  expect(decodeFig(fig).data.name).toBe('hello')
  const compressed=zstdCompressSync(raw),modern=new Uint8Array(20+parts[0].length+compressed.length)
  modern.set(fig.subarray(0,16+parts[0].length));new DataView(modern.buffer).setUint32(16+parts[0].length,compressed.length,true);modern.set(compressed,20+parts[0].length)
  expect(decodeFig(modern).data.name).toBe('hello')

  expect(decodeFig(zipSync({ 'canvas.fig': fig })).data.name).toBe('hello')
  expect(() => decodeFig(fig.slice(0, 20))).toThrow()
  const oversizedWindow=fig.slice();oversizedWindow.set([0x28,0xb5,0x2f,0xfd,0,255],20+parts[0].length)
  expect(()=>decodeFig(oversizedWindow)).toThrow('窗口')
  const untrusted = structuredClone(schema)
  untrusted.definitions[0].fields[0].name = '__proto__'
  const value = decodeKiwi(untrusted, raw)
  expect(Object.getPrototypeOf(value)).toBe(null)
  expect(value.__proto__).toBe('hello')
})
