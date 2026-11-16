import { expect, test, afterEach } from 'vitest'
import { Editor } from './engine'
import { blank, uid, validateDocument } from './model'
import { freehandNode, defaultBrush, defaultPencil, type PencilSettings } from './freehand'
import { brushPreviewSettings } from './draw-brush-style'
import { kernelSvgPaths } from './kernel/picking'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { validate_document_json } from './generated/design-kernel/design_kernel'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))

const straight = [
  { x: 8, y: 40, pressure: 0.5 },
  { x: 48, y: 40, pressure: 0.5 },
  { x: 96, y: 40, pressure: 0.5 },
  { x: 148, y: 40, pressure: 0.5 },
]
const curved = [
  { x: 8, y: 90, pressure: 0.4 },
  { x: 46, y: 24, pressure: 0.8 },
  { x: 92, y: 28, pressure: 0.45 },
  { x: 140, y: 96, pressure: 0.7 },
]

function settings(style?: 'heist' | 'bubblegum', width = 16): PencilSettings {
  return { ...defaultBrush(), width, color: '#7451ca', ...(style ? { style } : {}) }
}

function commit(samples: typeof straight, style: 'heist' | 'bubblegum', width = 16) {
  const editor = new Editor(blank())
  editors.push(editor)
  const draft = freehandNode(uid(), samples, settings(style, width), 1, 'brush')
  editor.addFreehand(draft)
  const node = editor.state.doc.nodes[draft.id]
  expect(node, style).toBeDefined()
  const paths = kernelSvgPaths(node)
  expect(paths, style).not.toBeNull()
  return { editor, id: draft.id, node, fill: paths!.fill }
}

test('a basic brush stroke stays a pressure stroke and a pencil ignores a brush style', () => {
  const plain = freehandNode(uid(), straight, defaultBrush(), 1, 'brush')
  expect(plain.vectorBrush).toBeUndefined()
  expect(plain.strokes[0].widthProfile?.length).toBeGreaterThan(0)
  expect(plain.strokes[0].visible).toBe(true)
  const pencil = freehandNode(uid(), straight, { ...defaultPencil(), width: 4, color: '#010203', style: 'heist' }, 1, 'pencil')
  expect(pencil.vectorBrush).toBeUndefined()
  expect(pencil.strokes[0].cap).toBe('round')
  expect(pencil.strokes[0].paint.color).toBe('#010203')
  const dot = freehandNode(uid(), [{ x: 5, y: 6, pressure: 0.5 }], settings('bubblegum'), 1, 'brush')
  expect(dot.kind).toBe('ellipse')
  expect(dot.vectorBrush).toBeUndefined()
})

test('an ordinary tight freehand curve with Stretch Heist commits a layer', () => {
  const samples = Array.from({ length: 80 }, (_, i) => {
    const t = i / 79
    return { x: t * 200, y: 140 * Math.sin(t * Math.PI * 2), pressure: 0.5 }
  })
  const editor = new Editor(blank())
  editors.push(editor)
  const plain = freehandNode(uid(), samples, { ...defaultBrush(), width: 12 }, 1, 'brush')
  editor.addFreehand(plain)
  expect(editor.state.doc.nodes[plain.id].vectorBrush).toBeUndefined()
  expect(editor.state.doc.nodes[plain.id].strokes[0].widthProfile?.length).toBeGreaterThan(0)
  const draft = freehandNode(uid(), samples, settings('heist', 12), 1, 'brush')
  editor.addFreehand(draft)
  const node = editor.state.doc.nodes[draft.id]
  expect(node, editor.state.message).toBeDefined()
  expect(node.vectorBrush?.mode, editor.state.message).toBe('stretch')
  expect(node.network!.edges.length).toBeGreaterThan(0)
  expect(kernelSvgPaths(node)!.fill.length, editor.state.message).toBeGreaterThan(0)
  editor.undo()
  expect(editor.state.doc.nodes[draft.id]).toBeUndefined()
  expect(editor.state.doc.nodes[plain.id].strokes[0].width).toBe(12)
})

test('gesture preview keeps the centerline and the commit applies the selected family', () => {
  const live = settings('bubblegum')
  const preview = brushPreviewSettings(live)
  expect(preview.style).toBeUndefined()
  expect(live.style).toBe('bubblegum')
  const previewNode = freehandNode(uid(), curved, preview, 1, 'brush')
  expect(previewNode.vectorBrush).toBeUndefined()
  expect(previewNode.strokes[0].visible).toBe(true)
  expect(previewNode.strokes[0].widthProfile?.length).toBeGreaterThan(0)
  const committed = freehandNode(uid(), curved, live, 1, 'brush')
  expect(committed.vectorBrush!.mode).toBe('scatter')
  expect(committed.strokes[0].widthProfile).toBeUndefined()
  expect(committed.network).toEqual(previewNode.network)
})

test('the same straight and curved strokes switch between Stretch Heist and Scatter Bubblegum', () => {
  const heistStraight = commit(straight, 'heist')
  const gumStraight = commit(straight, 'bubblegum')
  const heistCurved = commit(curved, 'heist')
  const gumCurved = commit(curved, 'bubblegum')
  expect(heistStraight.node.network).toEqual(gumStraight.node.network)
  expect(heistCurved.node.network).toEqual(gumCurved.node.network)
  expect(heistStraight.node.vectorBrush).toMatchObject({ mode: 'stretch', width: 16 })
  expect(gumStraight.node.vectorBrush).toMatchObject({ mode: 'scatter', width: 16 })
  expect(heistCurved.node.vectorBrush!.mode).toBe('stretch')
  expect(gumCurved.node.vectorBrush!.mode).toBe('scatter')
  expect(heistStraight.node.vectorBrush!.source.vertices[0].id.startsWith('draw-heist-')).toBe(true)
  expect(gumStraight.node.vectorBrush!.source.vertices[0].id.startsWith('draw-bubblegum-')).toBe(true)
  expect(heistStraight.fill).not.toBe(gumStraight.fill)
  expect(heistCurved.fill).not.toBe(gumCurved.fill)
  expect(heistStraight.fill.match(/M/g)?.length).toBe(1)
  expect(heistCurved.fill.match(/M/g)?.length).toBe(1)
  expect((gumStraight.fill.match(/M/g) ?? []).length).toBeGreaterThan(1)
  expect((gumCurved.fill.match(/M/g) ?? []).length).toBeGreaterThan(1)
  expect(heistStraight.node.fills[0].color).toBe('#7451ca')
  expect(heistStraight.node.strokes[0].width).toBe(16)
  expect(heistStraight.node.strokes[0].visible).toBe(false)
  expect(heistStraight.node.strokes[0].widthProfile).toBeUndefined()
  expect(heistStraight.node.name).toBe('Heist')
  expect(gumStraight.node.name).toBe('Bubblegum')
  const plain = kernelSvgPaths(freehandNode(uid(), straight, defaultBrush(), 1, 'brush'))!
  expect(heistStraight.fill).not.toBe(plain.fill)
  expect(heistStraight.fill).not.toBe(plain.stroke)
})

test('one undo keeps an earlier styled stroke, width and path edits undo once, and reopen keeps the style', () => {
  const editor = new Editor(blank())
  editors.push(editor)
  const heist = freehandNode(uid(), straight, settings('heist'), 1, 'brush')
  const gum = freehandNode(uid(), curved, settings('bubblegum', 18), 1, 'brush')
  editor.addFreehand(heist)
  editor.addFreehand(gum)
  expect(editor.state.doc.schemaVersion).toBeGreaterThanOrEqual(15)
  const heistFill = kernelSvgPaths(editor.state.doc.nodes[heist.id])!.fill
  const gumFill = kernelSvgPaths(editor.state.doc.nodes[gum.id])!.fill
  const heistGuide = structuredClone(editor.state.doc.nodes[heist.id].network)
  const gumBrush = structuredClone(editor.state.doc.nodes[gum.id].vectorBrush)
  editor.undo()
  expect(editor.state.doc.nodes[gum.id]).toBeUndefined()
  expect(editor.state.doc.nodes[heist.id].vectorBrush).toMatchObject({ mode: 'stretch', width: 16 })
  expect(kernelSvgPaths(editor.state.doc.nodes[heist.id])!.fill).toBe(heistFill)
  editor.redo()
  expect(editor.state.doc.nodes[gum.id].vectorBrush).toEqual(gumBrush)
  expect(kernelSvgPaths(editor.state.doc.nodes[gum.id])!.fill).toBe(gumFill)

  const spacing = editor.state.doc.nodes[gum.id].vectorBrush!.spacing
  const gumGuide = structuredClone(editor.state.doc.nodes[gum.id].network)
  editor.updateProperties([gum.id], node => { node.strokes[0].width = 36 }, '笔宽')
  const widened = editor.state.doc.nodes[gum.id]
  expect(widened.vectorBrush).toMatchObject({ mode: 'scatter', width: 36 })
  expect(widened.strokes[0].width).toBe(36)
  expect(widened.vectorBrush!.spacing).toBeCloseTo(spacing * 2, 5)
  expect(kernelSvgPaths(widened)!.fill).not.toBe(gumFill)
  expect(widened.network).toEqual(gumGuide)
  editor.undo()
  expect(editor.state.doc.nodes[gum.id].vectorBrush).toEqual(gumBrush)
  expect(kernelSvgPaths(editor.state.doc.nodes[gum.id])!.fill).toBe(gumFill)
  expect(editor.state.doc.nodes[heist.id].vectorBrush!.mode).toBe('stretch')

  const moved = structuredClone(heistGuide)!
  moved.vertices[moved.vertices.length - 1].x += 36
  editor.updateProperties([heist.id], node => { node.network = moved }, '编辑路径')
  const edited = editor.state.doc.nodes[heist.id]
  expect(edited.vectorBrush!.mode).toBe('stretch')
  expect(edited.network!.vertices.at(-1)!.x).toBe(heistGuide!.vertices.at(-1)!.x + 36)
  expect(kernelSvgPaths(edited)!.fill).not.toBe(heistFill)
  editor.undo()
  expect(editor.state.doc.nodes[heist.id].network).toEqual(heistGuide)
  expect(editor.state.doc.nodes[heist.id].vectorBrush!.mode).toBe('stretch')
  expect(kernelSvgPaths(editor.state.doc.nodes[heist.id])!.fill).toBe(heistFill)

  editor.updateProperties([heist.id], node => { node.strokes[0].paint = { ...node.strokes[0].paint, color: '#123456' } }, '颜色')
  expect(editor.state.doc.nodes[heist.id].fills[0].color).toBe('#123456')
  expect(editor.state.doc.nodes[heist.id].vectorBrush!.mode).toBe('stretch')
  editor.undo()
  expect(editor.state.doc.nodes[heist.id].fills[0].color).toBe('#7451ca')

  const rejected = editor.state.doc
  editor.updateProperties([heist.id], node => { node.strokes[0].width = 0 }, '零宽度')
  expect(editor.state.doc).toBe(rejected)
  expect(editor.state.message).toContain('Invalid vector brush parameters')
  expect(editor.state.doc.nodes[heist.id].vectorBrush!.mode).toBe('stretch')

  const saved = JSON.parse(JSON.stringify(editor.state.doc))
  const reopened = new Editor(blank())
  editors.push(reopened)
  expect(reopened.load(saved)).toBe(true)
  expect(reopened.state.doc.nodes[heist.id].vectorBrush).toEqual(editor.state.doc.nodes[heist.id].vectorBrush)
  expect(reopened.state.doc.nodes[gum.id].vectorBrush).toEqual(gumBrush)
  expect(reopened.state.doc.nodes[heist.id].network).toEqual(heistGuide)
  expect(kernelSvgPaths(reopened.state.doc.nodes[heist.id])!.fill).toBe(heistFill)
  expect(kernelSvgPaths(reopened.state.doc.nodes[gum.id])!.fill).toBe(gumFill)
  const binary = validateDocument(decodeDocumentBinary(encodeDocumentBinary(editor.state.doc)))
  expect(binary.nodes[heist.id].vectorBrush).toEqual(editor.state.doc.nodes[heist.id].vectorBrush)
  expect(binary.nodes[gum.id].vectorBrush).toEqual(gumBrush)
  expect(() => validate_document_json(JSON.stringify(editor.state.doc))).not.toThrow()
})
