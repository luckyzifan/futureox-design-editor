import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint, effect } from '../../model'
import { decodeScenePacket } from './scene-packet'
import { preparePreviewSelection, translatePreviewOffsets, translatePreviewScene } from './translated-scene'
import { sceneIndex } from './scene-index'

function fixture() {
  const doc = blank(), a = node('frame', 20, 20, 30, 30)
  a.blend = 'normal'; a.fills = [paint('#e05544', 'linear')]
  doc.nodes[a.id] = a; doc.pages[0].children = [a.id]
  const kernel = new VectorEngine()
  const compile = (document: typeof doc) => {
    kernel.load_document(JSON.stringify(document))
    return decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({ pageId: doc.pages[0].id,
      width: 100, height: 100, view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false })))
  }
  return { doc, a, kernel, compile }
}

test('integer root placement reuses local coverage and matches a fresh kernel compilation', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    const old = compile(doc)
    const next = { ...doc, nodes: { ...doc.nodes, [a.id]: { ...a, transform: [1, 0, 0, 1, 25, 24] as typeof a.transform } } }
    const moved = translatePreviewScene(old, doc, next)!, fresh = compile(next)
    expect(moved).not.toBeNull()
    expect(moved.curves).toBe(old.curves)
    expect(sceneIndex(moved)).toBe(sceneIndex(old))
    expect(moved.nodes[a.id].rect).toEqual(fresh.nodes[a.id].rect)
    expect(moved.nodes[a.id].matrix).toEqual(fresh.nodes[a.id].matrix)
    expect(moved.nodes[a.id].inverse).toEqual(fresh.nodes[a.id].inverse)
    expect(moved.nodes[a.id].fills.map(({ fixedGradient, ...paint }) => paint)).toEqual(fresh.nodes[a.id].fills.map(({ fixedGradient, ...paint }) => paint))
    // Translating already-rounded coefficients can differ by a few integer
    // units from freshly rounding their f64 expressions. Bound that transient
    // error; the browser gate independently compares the resulting GPU pixels.
    const signed = (words: number[]) => BigInt.asIntN(64, words.reduce((v, word, i) => v | BigInt(word) << BigInt(i * 16), 0n))
    const originalFixed = moved.nodes[a.id].fills[0].fixedGradient!, freshFixed = fresh.nodes[a.id].fills[0].fixedGradient!
    expect(originalFixed.bits).toBe(freshFixed.bits)
    expect(Math.abs(Number(signed(originalFixed.words[2]) - signed(freshFixed.words[2])))).toBeLessThanOrEqual(10)
    expect(moved.nodes[a.id].fill).toEqual(fresh.nodes[a.id].fill)
    expect(old.nodes[a.id].matrix[4]).toBe(20)
    expect(sceneIndex(fresh)).not.toBe(sceneIndex(old))
  } finally { kernel.free() }
})

test('content changes, replay dependencies, and newly exposed clipped geometry recompile', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    const old = compile(doc), moved = { ...doc, nodes: { ...doc.nodes,
      [a.id]: { ...a, transform: [1, 0, 0, 1, 90, 20] as typeof a.transform } } }
    expect(translatePreviewScene(old, doc, moved)).toBeNull()
    expect(translatePreviewScene(old, doc, { ...doc, nodes: { ...doc.nodes, [a.id]: { ...a, opacity: .5 } } })).toBeNull()
    old.nodes[a.id].captureReplay = {} as never
    expect(translatePreviewScene(old, doc, { ...doc, nodes: { ...doc.nodes, [a.id]: { ...a, transform: [1, 0, 0, 1, 25, 20] } } })).toBeNull()
  } finally { kernel.free() }
})

test('subpixel root movement regenerates coverage instead of filtering an old mask', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    const source = compile(doc)
    for (const dx of [.1, .2, .35, .7]) {
      const next = { ...doc, nodes: { ...doc.nodes, [a.id]: { ...a, transform: [1, 0, 0, 1, 20 + dx, 20] as typeof a.transform } } }
      expect(translatePreviewScene(source, doc, next)).toBeNull()
      expect(source.nodes[a.id].previewSource).toBeUndefined()
    }
  } finally { kernel.free() }
})
test.each(['backdropOutputBox','shadowOutputBox'] as const)('native painter %s is reissued after movement, never translated as geometry', field=>{
  const{doc,a,kernel,compile}=fixture()
  try{
    const source=compile(doc),box:[number,number,number,number]=[20,20,30,30]
    source.nodes[a.id][field]=box
    const next={...doc,nodes:{...doc.nodes,[a.id]:{...a,transform:[1,0,0,1,25,24] as typeof a.transform}}}
    expect(translatePreviewScene(source,doc,next)).toBeNull()
    expect(translatePreviewOffsets(source,new Map([[a.id,[5,4]]]),new Set(),new Set())).toBeNull()
    expect(source.nodes[a.id][field]).toBe(box)
    expect(source.nodes[a.id].matrix[4]).toBe(20)
  }finally{kernel.free()}
})

test('guarded viewport permits clipped geometry motion but bounds cumulative travel', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    const source = compile(doc)
    source.interactionWindow = { x: 20, y: 20, w: 60, h: 60 }
    source.nodes[a.id].rect = { ...source.nodes[a.id].rect, x: source.extent.x }
    const at = (x: number) => ({ ...doc, nodes: { ...doc.nodes, [a.id]: { ...a, transform: [1, 0, 0, 1, x, 20] as typeof a.transform } } })
    const first = at(30), shifted = translatePreviewScene(source, doc, first)!
    expect(shifted).not.toBeNull()
    expect(translatePreviewScene(shifted, first, at(35))).not.toBeNull()
    expect(translatePreviewScene(shifted, first, at(45))).toBeNull()
  } finally { kernel.free() }
})

test('nested translation uses its parent matrix and invalidates ancestor paint without rebuilding coverage', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    a.width = a.height = 60; a.clip = true; a.transform = [0, 1, -1, 0, 80, 10]
    const group = node('group', 2, 3, 20, 20), leaf = node('rectangle', 4, 5, 8, 9)
    group.blend = 'normal'; group.children = [leaf.id]; a.children = [group.id]
    doc.nodes[group.id] = group; doc.nodes[leaf.id] = leaf
    const source = compile(doc)
    const movedDoc = { ...doc, nodes: { ...doc.nodes, [leaf.id]: { ...leaf, transform: [1, 0, 0, 1, 11, 9] as typeof leaf.transform } } }
    const moved = translatePreviewScene(source, doc, movedDoc)!, fresh = compile(movedDoc)
    expect(moved).not.toBeNull()
    expect(moved.nodes[leaf.id].matrix).toEqual(fresh.nodes[leaf.id].matrix)
    expect(moved.nodes[leaf.id].inverse).toEqual(fresh.nodes[leaf.id].inverse)
    expect(moved.nodes[leaf.id].fill.area).toBe(source.nodes[leaf.id].fill.area)
    expect(moved.nodes[a.id]).not.toBe(source.nodes[a.id])
    expect(moved.nodes[group.id]).not.toBe(source.nodes[group.id])
    expect(moved.nodes[a.id].previewSource).toBeUndefined()
    expect(moved.nodes[a.id].previewDynamic).toBe(true)
    expect(moved.nodes[group.id].previewSource).toBeUndefined()
    expect(moved.nodes[a.id].rect).toEqual(source.nodes[a.id].rect)
  } finally { kernel.free() }
})

test('selection prewarming keeps ancestors dynamic and leaves reusable leaf geometry intact', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    const leaf = node('rectangle', 3, 4, 8, 9); a.children = [leaf.id]; doc.nodes[leaf.id] = leaf
    const source = compile(doc), prepared = preparePreviewSelection(source, [leaf.id])
    expect(prepared.nodes[a.id].previewDynamic).toBe(true)
    expect(prepared.nodes[leaf.id]).toBe(source.nodes[leaf.id])
    expect(source.nodes[a.id].previewDynamic).toBeUndefined()
    expect(preparePreviewSelection(source, [a.id])).toBe(source)
  } finally { kernel.free() }
})

test('nested masks, ancestor effects and derived layout keep the complete compile path', () => {
  const { doc, a, kernel, compile } = fixture()
  try {
    const leaf = node('rectangle', 3, 4, 8, 9)
    a.children = [leaf.id]; doc.nodes[leaf.id] = leaf
    for (const scenario of ['mask', 'blur', 'layout'] as const) {
      a.effects = scenario === 'blur' ? [effect('blur')] : []
      a.layout = scenario === 'layout' ? { mode: 'horizontal', gap: 0, padding: [0, 0, 0, 0], align: 'start', justify: 'start' } as typeof a.layout : undefined
      leaf.mask = scenario === 'mask'
      const source = compile(doc), moved = { ...doc, nodes: { ...doc.nodes, [leaf.id]: { ...leaf, transform: [1, 0, 0, 1, 7, 8] as typeof leaf.transform } } }
      expect(translatePreviewScene(source, doc, moved)).toBeNull()
    }
  } finally { kernel.free() }
})
