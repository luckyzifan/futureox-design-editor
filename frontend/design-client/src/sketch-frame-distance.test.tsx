// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { Inspector } from './Inspector'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { blank, node, type Matrix } from './model'
import { sketchFrameEdges, sketchFrameDistance } from './sketch-frame-distance'

const ARTBOARD = { x: -410, y: 358, width: 1922, height: 1080 }
const GROUP = { x: 263, y: 135 }
const IMAGE = { x: 0, y: 90.6031494140625, width: 1393, height: 762.819580078125 }

let root: Root | undefined
beforeEach(() => { interfacePreference.reset() })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

function imagePng() {
  const doc = blank('117')
  const artboard = node('frame', ARTBOARD.x, ARTBOARD.y, ARTBOARD.width, ARTBOARD.height)
  const group = node('group', GROUP.x, GROUP.y, 1393, 945)
  const mask = node('rectangle', 0, 0, 1393, 945)
  const image = node('rectangle', IMAGE.x, IMAGE.y, IMAGE.width, IMAGE.height)
  artboard.name = '117'
  artboard.clip = true
  group.name = '主视觉'
  mask.name = '椭圆 63'
  mask.mask = true
  image.name = 'image.png'
  artboard.children = [group.id]
  group.children = [mask.id, image.id]
  doc.nodes = { [artboard.id]: artboard, [group.id]: group, [mask.id]: mask, [image.id]: image }
  doc.pages[0].children = [artboard.id]
  return { doc, artboard, group, mask, image }
}

async function mount(editor: Editor) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<PendingEditContext.Provider value={editor}><Inspector editor={editor} /></PendingEditContext.Provider>)
  })
}
function field(label: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(input).not.toBeNull()
  return input!
}
async function commitField(label: string, value: number) {
  const input = field(label)
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}
function linear(matrix: Matrix) { return matrix.slice(0, 4) }

test('Sketch inspector reads and writes 117 image.png artboard edges, and one undo restores them', async () => {
  const { doc, artboard, group, mask, image } = imagePng()
  const editor = new Editor(doc)
  try {
    interfacePreference.set({ uiMode: 'sketch' })
    editor.select([image.id])
    const before = editor.state.doc
    await mount(editor)
    expect(Number(field('X').value)).toBe(263)
    expect(Number(field('Y').value)).toBe(225.6)
    expect(Number(field('距画框右边').value)).toBe(266)
    expect(Number(field('距画框下边').value)).toBe(91.58)
    expect(Number(field('W').value)).toBe(1393)
    expect(Number(field('H').value)).toBe(762.82)
    expect(field('X').closest('.geometry-position')).not.toBeNull()
    expect(field('距画框右边').closest('.geometry-frame-edges')).not.toBeNull()
    expect(field('W').closest('.geometry-position-section')).not.toBeNull()
    const pins = document.querySelector('[aria-label="父画板尺寸约束"]')
    expect(pins).not.toBeNull()
    expect(pins?.querySelector('[aria-label="左侧"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(pins?.querySelector('[aria-label="右侧"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(editor.state.doc).toBe(before)

    await commitField('距画框右边', 200)
    const moved = editor.state.doc
    const bitmap = moved.nodes[image.id]
    expect(bitmap.transform[4]).toBe(ARTBOARD.width - 200 - IMAGE.width - GROUP.x)
    expect(bitmap.transform[5]).toBe(IMAGE.y)
    expect(linear(bitmap.transform)).toEqual([1, 0, 0, 1])
    expect(bitmap.width).toBe(IMAGE.width)
    expect(bitmap.height).toBe(IMAGE.height)
    expect(moved.nodes[artboard.id].transform).toEqual(before.nodes[artboard.id].transform)
    expect(moved.nodes[group.id].transform).toEqual(before.nodes[group.id].transform)
    expect(moved.nodes[mask.id].transform).toEqual(before.nodes[mask.id].transform)
    expect(moved.nodes[artboard.id].clip).toBe(true)
    expect(moved.nodes[mask.id].mask).toBe(true)
    expect(Number(field('距画框右边').value)).toBe(200)
    expect(Number(field('X').value)).toBe(263 + bitmap.transform[4])
    await act(async () => { editor.undo() })
    expect(editor.state.doc).toEqual(before)
    expect(Number(field('X').value)).toBe(263)
    expect(Number(field('距画框右边').value)).toBe(266)
    expect(Number(field('距画框下边').value)).toBe(91.58)

    await commitField('Y', 200)
    expect(editor.state.doc.nodes[image.id].transform[5]).toBeCloseTo(200 - GROUP.y, 8)
    expect(editor.state.doc.nodes[mask.id].transform).toEqual(before.nodes[mask.id].transform)
    await act(async () => { editor.undo() })
    expect(editor.state.doc).toEqual(before)
    expect(Number(field('Y').value)).toBe(225.6)

    const rightPin = document.querySelector<HTMLButtonElement>('[aria-label="右侧"]')
    await act(async () => { rightPin!.click() })
    expect(editor.state.doc.nodes[image.id].constraints?.horizontal).toBe('end')
    expect(editor.state.doc.nodes[image.id].transform).toEqual(before.nodes[image.id].transform)
    expect(editor.state.doc.nodes[artboard.id].transform).toEqual(before.nodes[artboard.id].transform)
    expect(editor.state.doc.nodes[mask.id].transform).toEqual(before.nodes[mask.id].transform)
    await act(async () => { editor.undo() })
    expect(editor.state.doc).toEqual(before)
    expect(editor.state.doc.nodes[image.id].constraints).toBeUndefined()
    expect(document.querySelector('[aria-label="右侧"]')?.getAttribute('aria-pressed')).toBe('false')
  } finally { editor.dispose() }
})

test('Figma keeps frame X/Y without Sketch edge fields, and a rotated group stays local', async () => {
  const { doc, image } = imagePng()
  const editor = new Editor(doc)
  try {
    editor.select([image.id])
    await mount(editor)
    expect(Number(field('X').value)).toBe(263)
    expect(Number(field('Y').value)).toBe(225.6)
    expect(document.querySelector('input[aria-label="距画框右边"]')).toBeNull()
    expect(document.querySelector('[aria-label="父画板尺寸约束"]')).toBeNull()
    const rotated = node('group', 10, 20, 30, 30)
    rotated.transform = [0, 1, -1, 0, 10, 20]
    const child = node('rectangle', 5, 6, 8, 9)
    const frame = node('frame', 0, 0, 400, 300)
    frame.children = [rotated.id]
    rotated.children = [child.id]
    const local = blank('rotated')
    local.nodes = { [frame.id]: frame, [rotated.id]: rotated, [child.id]: child }
    local.pages[0].children = [frame.id]
    const localEditor = new Editor(local)
    try {
      await act(async () => { interfacePreference.set({ uiMode: 'sketch' }) })
      localEditor.select([child.id])
      await act(async () => {
        root!.render(<PendingEditContext.Provider value={localEditor}><Inspector editor={localEditor} /></PendingEditContext.Provider>)
      })
      expect(Number(field('X').value)).toBe(5)
      expect(Number(field('Y').value)).toBe(6)
      expect(document.querySelector('input[aria-label="距画框右边"]')).toBeNull()
      expect(document.querySelector('[aria-label="父画板尺寸约束"]')).toBeNull()
      expect(sketchFrameDistance(localEditor.state.doc, child.id, localEditor.parentMap())).toBeUndefined()
      const distance = sketchFrameDistance(editor.state.doc, image.id, editor.parentMap())
      expect(distance).toBeTruthy()
      const box = { x: IMAGE.x, y: IMAGE.y, width: IMAGE.width, height: IMAGE.height }
      expect(sketchFrameEdges(box, distance!, editor.state.doc.nodes[distance!.frameId]).right).toBe(266)
    } finally { localEditor.dispose() }
  } finally { editor.dispose() }
})
