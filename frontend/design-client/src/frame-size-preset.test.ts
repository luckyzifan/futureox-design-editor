// Issue #499 sizes: the selected Figma frame was reported as 01_Dashboard 1440×1640
// and the selected Sketch frame as 117 1922×1080. Those outer names and sizes are
// recreated here. Inner layers are a synthetic stand-in; the original files and
// test-results/native-interaction-audit-20261116 were not in this workspace.
// Child positions are the existing layout solve for these inputs, not a native-app measurement.
import { expect, test } from 'vitest'
import { presentChrome } from './english-chrome'
import { Editor } from './engine'
import { applyFrameSizePreset, createPresetFrame, framePresets, frameSizePresetGate } from './frame-presets'
import { blank, defaultLayout, defaultSizing, node, type ConstraintAnchor, type DesignDocument, type DesignNode } from './model'

const phone = framePresets.find(preset => preset.name === 'iPhone 13 / 13 Pro')
if (!phone) throw new Error('missing iPhone 13 / 13 Pro preset')

function color(target: DesignNode, value: string) {
  const fill = target.fills[0]
  if (fill?.kind === 'solid') fill.color = value
  return target
}
function pin(target: DesignNode, horizontal: ConstraintAnchor, vertical: ConstraintAnchor, referenceWidth: number, referenceHeight: number) {
  target.constraints = { horizontal, vertical, referenceWidth, referenceHeight }
  return target
}
function add(doc: DesignDocument, parent: { children: string[] }, child: DesignNode) {
  doc.nodes[child.id] = child
  parent.children.push(child.id)
  return child
}
function box(target: DesignNode) {
  const fill = target.fills[0]
  return {
    name: target.name,
    x: target.transform[4], y: target.transform[5],
    basis: target.transform.slice(0, 4),
    width: target.width, height: target.height,
    constraints: target.constraints ?? null,
    color: fill?.kind === 'solid' ? fill.color : null,
    visible: target.visible, locked: target.locked, clip: target.clip,
  }
}
function dashboard() {
  const doc = blank('01有料素材副本')
  doc.schemaVersion = 7
  const frame = node('frame', 80, 90, 1440, 1640)
  frame.name = '01_Dashboard'
  frame.clip = true
  frame.constrainProportions = true
  frame.transform = [0, 1, -1, 0, 80, 90]
  color(frame, '#112233')
  const end = pin(color(node('rectangle', 1200, 1500, 100, 80), '#111111'), 'end', 'end', 1440, 1640)
  end.name = '贴右'
  const center = pin(color(node('rectangle', 100, 200, 50, 40), '#222222'), 'center', 'center', 1440, 1640)
  center.name = '居中'
  const stretch = pin(color(node('rectangle', 20, 10, 1300, 30), '#333333'), 'stretch', 'start', 1440, 1640)
  stretch.name = '拉伸'
  const scale = pin(color(node('rectangle', 480, 410, 96, 410), '#444444'), 'scale', 'scale', 1440, 1640)
  scale.name = '缩放'
  const start = pin(color(node('rectangle', 48, 64, 70, 20), '#555555'), 'start', 'start', 1440, 1640)
  start.name = '贴左'
  const free = color(node('rectangle', 24, 36, 80, 40), '#666666')
  free.name = '自由'
  const overflow = color(node('rectangle', 1000, 80, 50, 50), '#777777')
  overflow.name = '超出'
  const locked = pin(color(node('rectangle', 1100, 20, 40, 40), '#888888'), 'end', 'start', 1440, 1640)
  locked.name = '锁定'
  locked.visible = false
  locked.locked = true
  const card = pin(color(node('frame', 1000, 40, 400, 220), '#999999'), 'end', 'start', 1440, 1640)
  card.name = '卡片'
  card.clip = true
  const inner = pin(color(node('rectangle', 12, 18, 30, 30), '#aaaaaa'), 'start', 'start', 400, 220)
  inner.name = '卡片内'
  const sibling = color(node('rectangle', 0, 0, 10, 10), '#bbbbbb')
  sibling.name = '旁侧'
  add(doc, doc.pages[0], frame)
  for (const child of [end, center, stretch, scale, start, free, overflow, locked, card]) add(doc, frame, child)
  add(doc, card, inner)
  add(doc, doc.pages[0], sibling)
  return { doc, frame, end, center, stretch, scale, start, free, overflow, locked, card, inner, sibling }
}
function sketchboard() {
  const doc = blank('117')
  const frame = node('frame', 40, 50, 1922, 1080)
  frame.name = '117'
  frame.clip = false
  frame.constrainProportions = false
  color(frame, '#abcdef')
  const end = pin(color(node('rectangle', 1700, 900, 100, 80), '#010101'), 'end', 'end', 1922, 1080)
  end.name = '贴边'
  const free = color(node('rectangle', 30, 40, 50, 20), '#020202')
  free.name = '内容'
  const sibling = color(node('rectangle', 8, 8, 12, 12), '#030303')
  sibling.name = '旁侧'
  add(doc, doc.pages[0], frame)
  add(doc, frame, end)
  add(doc, frame, free)
  add(doc, doc.pages[0], sibling)
  return { doc, frame, end, free, sibling }
}
function use(doc: DesignDocument, selected: string) {
  const editor = new Editor(doc)
  editor.select([selected])
  return editor
}

test('iPhone 13 / 13 Pro resizes 01_Dashboard, solves constraints, keeps clip and undoes as one document', () => {
  expect(phone).toMatchObject({ width: 390, height: 844 })
  const built = dashboard()
  const editor = use(built.doc, built.frame.id)
  try {
    const before = editor.state.doc
    const frame = before.nodes[built.frame.id]
    expect(frame).toMatchObject({ name: '01_Dashboard', width: 1440, height: 1640, clip: true, constrainProportions: true })
    expect(frame.transform).toEqual([0, 1, -1, 0, 80, 90])
    expect(box(before.nodes[built.end.id])).toMatchObject({ x: 1200, y: 1500, width: 100, height: 80 })
    expect(Object.keys(before.nodes)).toHaveLength(12)
    const created = createPresetFrame(editor, phone)
    expect(created.ok).toBe(true)
    expect(editor.state.doc.nodes[built.frame.id]).toMatchObject({ width: 1440, height: 1640, name: '01_Dashboard' })
    expect(editor.state.doc.nodes[created.id!]).toMatchObject({ kind: 'frame', name: 'iPhone 13 / 13 Pro', width: 390, height: 844 })
    expect(editor.state.doc.pages[0].children).toContain(created.id)
    expect(editor.state.doc.nodes[built.frame.id].children).not.toContain(created.id)
    expect(editor.state.selection).toEqual([created.id])
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
    editor.select([built.frame.id])
    const applied = applyFrameSizePreset(editor, phone, built.frame.id)
    expect(applied).toEqual({ ok: true })
    const next = editor.state.doc
    expect(next).not.toBe(before)
    expect(Object.keys(next.nodes)).toHaveLength(12)
    expect(next.pages[0].children).toEqual(before.pages[0].children)
    expect(editor.state.selection).toEqual([built.frame.id])
    expect(editor.state.message).toBe('应用画板尺寸预设')
    expect(presentChrome('撤销：应用画板尺寸预设', 'en')).toBe('Undo: Apply frame size preset')
    const resized = next.nodes[built.frame.id]
    expect(resized).toMatchObject({ name: '01_Dashboard', width: 390, height: 844, clip: true, constrainProportions: true })
    expect(resized.transform).toEqual([0, 1, -1, 0, 80, 90])
    expect(resized.fills).toEqual(before.nodes[built.frame.id].fills)
    expect(box(next.nodes[built.end.id])).toEqual({ ...box(before.nodes[built.end.id]), x: 150, y: 704, constraints: { horizontal: 'end', vertical: 'end', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(next.nodes[built.center.id])).toEqual({ ...box(before.nodes[built.center.id]), x: -425, y: -198, constraints: { horizontal: 'center', vertical: 'center', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(next.nodes[built.stretch.id])).toEqual({ ...box(before.nodes[built.stretch.id]), width: 250, constraints: { horizontal: 'stretch', vertical: 'start', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(next.nodes[built.scale.id])).toEqual({ ...box(before.nodes[built.scale.id]), x: 130, y: 211, width: 26, height: 211, constraints: { horizontal: 'scale', vertical: 'scale', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(next.nodes[built.start.id])).toEqual({ ...box(before.nodes[built.start.id]), constraints: { horizontal: 'start', vertical: 'start', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(next.nodes[built.free.id])).toEqual(box(before.nodes[built.free.id]))
    expect(box(next.nodes[built.overflow.id])).toEqual(box(before.nodes[built.overflow.id]))
    expect(box(next.nodes[built.locked.id])).toEqual({ ...box(before.nodes[built.locked.id]), x: 50, constraints: { horizontal: 'end', vertical: 'start', referenceWidth: 390, referenceHeight: 844 } })
    expect(next.nodes[built.locked.id].visible).toBe(false)
    expect(next.nodes[built.locked.id].locked).toBe(true)
    expect(box(next.nodes[built.card.id])).toEqual({ ...box(before.nodes[built.card.id]), x: -50, constraints: { horizontal: 'end', vertical: 'start', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(next.nodes[built.inner.id])).toEqual(box(before.nodes[built.inner.id]))
    expect(next.nodes[built.sibling.id]).toEqual(before.nodes[built.sibling.id])
    expect(applyFrameSizePreset(editor, phone, built.frame.id)).toEqual({ ok: true })
    expect(editor.state.doc).toBe(next)
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.message).toBe('撤销：应用画板尺寸预设')
    expect(editor.canUndo).toBe(false)
    editor.redo()
    expect(editor.state.doc).toBe(next)
    editor.undo()
    expect(editor.state.doc).toBe(before)
  } finally { editor.dispose() }
})

test('iPhone 13 / 13 Pro and its swapped orientation resize Sketch frame 117 without turning clipping on', () => {
  const built = sketchboard()
  const editor = use(built.doc, built.frame.id)
  try {
    const before = editor.state.doc
    expect(before.nodes[built.frame.id]).toMatchObject({ name: '117', width: 1922, height: 1080, clip: false })
    expect(before.nodes[built.frame.id].transform).toEqual([1, 0, 0, 1, 40, 50])
    expect(applyFrameSizePreset(editor, phone, built.frame.id)).toEqual({ ok: true })
    const portrait = editor.state.doc
    expect(portrait.nodes[built.frame.id]).toMatchObject({ name: '117', width: 390, height: 844, clip: false })
    expect(portrait.nodes[built.frame.id].transform).toEqual([1, 0, 0, 1, 40, 50])
    expect(box(portrait.nodes[built.end.id])).toEqual({ ...box(before.nodes[built.end.id]), x: 168, y: 664, constraints: { horizontal: 'end', vertical: 'end', referenceWidth: 390, referenceHeight: 844 } })
    expect(box(portrait.nodes[built.free.id])).toEqual(box(before.nodes[built.free.id]))
    expect(portrait.nodes[built.sibling.id]).toEqual(before.nodes[built.sibling.id])
    expect(Object.keys(portrait.nodes)).toHaveLength(Object.keys(before.nodes).length)
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(applyFrameSizePreset(editor, { width: phone.height, height: phone.width }, built.frame.id)).toEqual({ ok: true })
    const landscape = editor.state.doc
    expect(landscape.nodes[built.frame.id]).toMatchObject({ width: 844, height: 390, clip: false, name: '117' })
    expect(box(landscape.nodes[built.end.id])).toMatchObject({ x: 622, y: 210, width: 100, height: 80 })
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})

test('preset refusals leave the document and undo stack untouched', () => {
  const built = dashboard()
  const editor = use(built.doc, built.frame.id)
  try {
    const before = editor.state.doc
    expect(applyFrameSizePreset(editor, { width: 0, height: 10 }, built.frame.id)).toEqual({ ok: false, error: '宽高必须为 1–100000 的整数' })
    editor.set({ busy: true })
    expect(applyFrameSizePreset(editor, phone, built.frame.id)).toEqual({ ok: false, error: '请先结束当前输入或操作' })
    editor.set({ busy: false })
    editor.select([built.sibling.id])
    expect(applyFrameSizePreset(editor, phone, built.frame.id)).toEqual({ ok: false, error: '所选画板已变化，请关闭后重新打开' })
    editor.select([built.frame.id, built.sibling.id])
    expect(applyFrameSizePreset(editor, phone)).toEqual({ ok: false, error: '请先选中一个画板' })
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
    expect(editor.canRedo).toBe(false)
  } finally { editor.dispose() }
})

test('locked, limited, stretched, graphic and instance frames do not take a preset', () => {
  const lockedParent = blank('锁定')
  const parent = node('frame', 0, 0, 800, 600)
  parent.locked = true
  const child = node('frame', 10, 10, 200, 120)
  child.name = '内层'
  add(lockedParent, lockedParent.pages[0], parent)
  add(lockedParent, parent, child)
  const lockedEditor = use(lockedParent, child.id)
  try {
    const before = lockedEditor.state.doc
    expect(frameSizePresetGate(before, lockedEditor.state.page, [child.id], lockedEditor.parentMap())).toBe('locked')
    expect(applyFrameSizePreset(lockedEditor, phone, child.id)).toEqual({ ok: false, error: '画板已锁定' })
    expect(lockedEditor.state.doc).toBe(before)
    expect(lockedEditor.canUndo).toBe(false)
  } finally { lockedEditor.dispose() }

  const limited = blank('限制')
  const small = node('frame', 0, 0, 180, 80)
  small.sizing = { ...defaultSizing(), maxWidth: 200, maxHeight: 100 }
  add(limited, limited.pages[0], small)
  const limitedEditor = use(limited, small.id)
  try {
    const before = limitedEditor.state.doc
    expect(before.nodes[small.id].width).toBe(180)
    expect(applyFrameSizePreset(limitedEditor, phone, small.id)).toEqual({ ok: false, error: '预设尺寸超出该画板的最小或最大尺寸' })
    expect(limitedEditor.state.doc).toBe(before)
    expect(limitedEditor.canUndo).toBe(false)
    expect(limitedEditor.canRedo).toBe(false)
  } finally { limitedEditor.dispose() }

  const stretched = blank('拉伸父级')
  const board = node('frame', 0, 0, 900, 700)
  board.layout = { ...defaultLayout(), mode: 'horizontal', align: 'stretch' }
  board.sizing = { ...defaultSizing() }
  const item = node('frame', 0, 0, 120, 80)
  item.name = '被拉伸'
  add(stretched, stretched.pages[0], board)
  add(stretched, board, item)
  const stretchEditor = use(stretched, item.id)
  try {
    const before = stretchEditor.state.doc
    expect(applyFrameSizePreset(stretchEditor, phone, item.id)).toEqual({ ok: false, error: '父级自动布局会改写该画板尺寸，预设未应用' })
    expect(stretchEditor.state.doc).toBe(before)
    expect(stretchEditor.canUndo).toBe(false)
  } finally { stretchEditor.dispose() }

  const graphicDoc = blank('图形')
  graphicDoc.schemaVersion = 23
  const graphic = node('frame', 0, 0, 64, 64)
  graphic.graphic = true
  graphic.name = '图标'
  add(graphicDoc, graphicDoc.pages[0], graphic)
  const parents = new Map([[graphic.id, graphicDoc.pages[0].id]])
  expect(frameSizePresetGate(graphicDoc, graphicDoc.pages[0].id, [graphic.id], parents)).toBe('graphic')
  graphic.graphic = false
  graphic.instance = { componentId: 'missing', overrides: {}, propertyValues: {} }
  expect(frameSizePresetGate(graphicDoc, graphicDoc.pages[0].id, [graphic.id], parents)).toBe('instance')
  const graphicTransaction = blank('图形事务')
  graphicTransaction.schemaVersion = 23
  const icon = node('frame', 0, 0, 64, 64)
  icon.graphic = true
  icon.name = '图标'
  add(graphicTransaction, graphicTransaction.pages[0], icon)
  const graphicEditor = use(graphicTransaction, icon.id)
  try {
    const before = graphicEditor.state.doc
    expect(applyFrameSizePreset(graphicEditor, phone, icon.id)).toEqual({ ok: false, error: '图形容器不使用画板尺寸预设' })
    expect(graphicEditor.state.doc).toBe(before)
    expect(graphicEditor.canUndo).toBe(false)
  } finally { graphicEditor.dispose() }
})

test('a hug frame keeps the preset instead of snapping back, and auto layout reflows direct children', () => {
  const hugged = blank('拥抱')
  const frame = node('frame', 0, 0, 1440, 1640)
  frame.name = '拥抱画板'
  frame.clip = true
  frame.layout = { ...defaultLayout(), mode: 'horizontal', padding: [16, 16, 16, 16], gap: 0, align: 'start', justify: 'start' }
  frame.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  const child = node('rectangle', 40, 40, 100, 40)
  child.name = '内容'
  add(hugged, hugged.pages[0], frame)
  add(hugged, frame, child)
  const hugEditor = use(hugged, frame.id)
  try {
    const before = hugEditor.state.doc
    expect(before.nodes[frame.id]).toMatchObject({ width: 132, height: 72 })
    expect(before.nodes[frame.id].sizing).toMatchObject({ width: 'hug', height: 'hug' })
    expect(before.nodes[child.id].transform.slice(4)).toEqual([16, 16])
    expect(applyFrameSizePreset(hugEditor, phone, frame.id)).toEqual({ ok: true })
    const next = hugEditor.state.doc
    expect(next.nodes[frame.id]).toMatchObject({ width: 390, height: 844, clip: true, name: '拥抱画板' })
    expect(next.nodes[frame.id].sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
    expect(next.nodes[child.id]).toMatchObject({ width: 100, height: 40 })
    expect(next.nodes[child.id].transform.slice(4)).toEqual([16, 16])
    hugEditor.undo()
    expect(hugEditor.state.doc).toBe(before)
  } finally { hugEditor.dispose() }

  const flowed = blank('重排')
  const board = node('frame', 0, 0, 1440, 1640)
  board.name = '重排画板'
  board.clip = false
  board.layout = { ...defaultLayout(), mode: 'horizontal', padding: [16, 16, 16, 16], gap: 8, align: 'start', justify: 'start' }
  board.sizing = { ...defaultSizing(), width: 'fixed', height: 'fixed' }
  const fixed = node('rectangle', 0, 0, 100, 40)
  fixed.name = '固定'
  const fill = node('rectangle', 0, 0, 20, 40)
  fill.name = '填充'
  fill.sizing = { ...defaultSizing(), width: 'fill', height: 'fixed' }
  const pinned = node('rectangle', 1200, 1500, 80, 60)
  pinned.name = '绝对'
  pinned.sizing = { ...defaultSizing(), absolute: true }
  pin(pinned, 'end', 'end', 1440, 1640)
  add(flowed, flowed.pages[0], board)
  add(flowed, board, fixed)
  add(flowed, board, fill)
  add(flowed, board, pinned)
  const flowEditor = use(flowed, board.id)
  try {
    const before = flowEditor.state.doc
    expect(before.nodes[board.id]).toMatchObject({ width: 1440, height: 1640, clip: false })
    expect(before.nodes[fill.id].width).toBeCloseTo(1300, 6)
    expect(applyFrameSizePreset(flowEditor, phone, board.id)).toEqual({ ok: true })
    const next = flowEditor.state.doc
    expect(next.nodes[board.id]).toMatchObject({ width: 390, height: 844, clip: false, name: '重排画板' })
    expect(next.nodes[board.id].layout).toEqual(before.nodes[board.id].layout)
    expect(next.nodes[fixed.id]).toMatchObject({ width: 100, height: 40 })
    expect(next.nodes[fixed.id].transform.slice(4)).toEqual([16, 16])
    expect(next.nodes[fill.id].width).toBeCloseTo(250, 6)
    expect(next.nodes[fill.id].height).toBe(40)
    expect(next.nodes[fill.id].transform[4]).toBeCloseTo(124, 6)
    expect(next.nodes[fill.id].transform[5]).toBe(16)
    expect(box(next.nodes[pinned.id])).toMatchObject({ x: 150, y: 704, width: 80, height: 60, constraints: { horizontal: 'end', vertical: 'end', referenceWidth: 390, referenceHeight: 844 } })
    expect(next.nodes[pinned.id].sizing).toMatchObject({ absolute: true })
    flowEditor.undo()
    expect(flowEditor.state.doc).toBe(before)
  } finally { flowEditor.dispose() }
})

test('crop mode is cleared by a preset and a fill child keeps the preset size', () => {
  const doc = blank('填充子级')
  const parent = node('frame', 0, 0, 800, 600)
  parent.layout = { ...defaultLayout(), mode: 'horizontal', padding: [0, 0, 0, 0], gap: 0, align: 'start', justify: 'start' }
  parent.sizing = { ...defaultSizing() }
  const child = node('frame', 0, 0, 800, 600)
  child.name = '填充画板'
  child.clip = true
  child.sizing = { ...defaultSizing(), width: 'fill', height: 'fill' }
  add(doc, doc.pages[0], parent)
  add(doc, parent, child)
  const editor = use(doc, child.id)
  try {
    const before = editor.state.doc
    expect(before.nodes[child.id].sizing).toMatchObject({ width: 'fill', height: 'fill' })
    editor.set({ tool: 'select', frameCrop: child.id })
    expect(editor.state.frameCrop).toBe(child.id)
    expect(applyFrameSizePreset(editor, phone, child.id)).toEqual({ ok: true })
    expect(editor.state.frameCrop).toBeNull()
    expect(editor.state.doc.nodes[child.id]).toMatchObject({ width: 390, height: 844, clip: true, name: '填充画板' })
    expect(editor.state.doc.nodes[child.id].sizing).toMatchObject({ width: 'fixed', height: 'fixed' })
    expect(editor.state.doc.nodes[parent.id]).toMatchObject({ width: 800, height: 600 })
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.frameCrop).toBeNull()
  } finally { editor.dispose() }
})
