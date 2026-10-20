import { expect, test } from 'vitest'
import { PreparationSnapshots } from './preparation-snapshot'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../model'
import { readFileSync } from 'node:fs'
import { createClip } from '../animation'
test('only complete equal content and resource policy admit a static lane fork', () => {
  const snapshots = new PreparationSnapshots(), json = '{"id":"same","nodes":{}}'
  snapshots.loaded('canvas', json)
  expect(snapshots.canFork('interaction', json)).toBe(false)
  snapshots.initialize('canvas', true); snapshots.initialize('interaction', false)
  expect(snapshots.canFork('interaction', json)).toBe(false)
  snapshots.initialize('interaction', true)
  expect(snapshots.canFork('interaction', json)).toBe(true)
  expect(snapshots.canFork('interaction', '{"id":"same","nodes":{"changed":{}}}')).toBe(false)
  expect(snapshots.canFork('canvas', json)).toBe(false)
  snapshots.invalidate('canvas')
  expect(snapshots.canFork('interaction', json)).toBe(false)
  expect(snapshots.canFork('interaction', undefined as unknown as string)).toBe(false)
})

test('a real WASM fork preserves font/geometry bytes and isolates edits and disposal', () => {
  const font = new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)))
  const doc = blank(), text = node('text', 10.125, 12.375, 100, 40)
  text.text = 'Canvas 14'; text.fills = [paint('#224466')]
  doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
  const source = new VectorEngine(), fresh = new VectorEngine()
  const options = JSON.stringify({pageId:doc.pages[0].id,width:160,height:80,view:{x:.25,y:.125,zoom:1.2}})
  let fork: VectorEngine | undefined, sourceFreed = false
  try {
    expect(source.fork_static_render_engine()).toBeUndefined()
    for(const engine of [source,fresh]){engine.load_font(font);engine.load_document(JSON.stringify(doc))}
    const original=source.compile_gpu_packet(options)
    expect(fresh.compile_gpu_packet(options)).toEqual(original)
    fork=source.fork_static_render_engine();expect(fork).toBeDefined()
    expect(fork!.compile_gpu_packet(options)).toEqual(original)
    const transforms=JSON.stringify({[text.id]:[1,0,0,1,16.375,19.125]})
    expect(fork!.apply_interaction_transforms(transforms)).toBe(true)
    expect(fresh.apply_interaction_transforms(transforms)).toBe(true)
    expect(fork!.compile_gpu_packet(options)).toEqual(fresh.compile_gpu_packet(options))
    expect(source.compile_gpu_packet(options)).toEqual(original)
    source.free();sourceFreed=true
    expect(fork!.compile_gpu_packet(options)).toEqual(fresh.compile_gpu_packet(options))
    for(const rasterProfile of ['analytic','figma','figmaSoftware'])for(const zoom of [.6,2.125]){
      const changed=JSON.stringify({...JSON.parse(options),rasterProfile,view:{x:-7.375,y:.625,zoom}})
      expect(fork!.compile_gpu_packet(changed)).toEqual(fresh.compile_gpu_packet(changed))
    }
    fresh.load_document(JSON.stringify({...doc,schemaVersion:4,animations:[createClip(doc,doc.pages[0].id,[text.id])]}))
    expect(fresh.fork_static_render_engine()).toBeUndefined()
  } finally {if(!sourceFreed)source.free();fork?.free();fresh.free()}
})


test('successful ordered canvas patches renew exact content, not ID or stale epoch', () => {
  const snapshots = new PreparationSnapshots(), doc = blank(), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  const initial = JSON.stringify(doc)
  snapshots.initialize('canvas', false); snapshots.initialize('interaction', false); snapshots.loaded('canvas', initial)
  const moved = { ...a, transform: [1, 0, 0, 1, 5, 0] }
  const patch = JSON.stringify({ nodes: { [a.id]: moved }, fields: {} })
  const commit = snapshots.beginPatch('canvas', patch)
  expect(snapshots.canFork('interaction', initial)).toBe(false)
  commit()
  const next = JSON.stringify({ ...doc, nodes: { ...doc.nodes, [a.id]: moved } })
  expect(snapshots.canFork('interaction', next)).toBe(true)
  expect(snapshots.canFork('interaction', initial)).toBe(false)
  expect(snapshots.canFork('interaction', JSON.stringify({ ...doc, name: 'same ID, different data' }))).toBe(false)
  const stale = snapshots.beginPatch('canvas', patch)
  snapshots.loaded('canvas', initial); stale()
  expect(snapshots.canFork('interaction', initial)).toBe(true)
  expect(snapshots.canFork('interaction', next)).toBe(false)
  snapshots.beginPatch('canvas', patch) // failed kernel operation: no commit
  expect(snapshots.canFork('interaction', initial)).toBe(false)
})

test('renewal preserves child order/resources and rejects noncanonical signed zero', () => {
  const snapshots = new PreparationSnapshots(), doc = blank(), a = node('rectangle', 0, 0, 10, 10)
  doc.nodes[a.id] = a; doc.pages[0].children = [a.id]
  snapshots.initialize('canvas', false); snapshots.initialize('interaction', false)
  const initial = JSON.stringify(doc), fonts = { font: { family: 'test', data: 'test-only-bytes', index: 0 } }
  snapshots.loaded('canvas', initial)
  snapshots.beginPatch('canvas', JSON.stringify({ nodes: {}, fields: { fonts } }))()
  const next = JSON.stringify({ ...doc, fonts })
  expect(snapshots.canFork('interaction', next)).toBe(true)
  expect(snapshots.canFork('interaction', initial)).toBe(false)
  snapshots.initialize('interaction', true)
  expect(snapshots.canFork('interaction', next)).toBe(false)
  snapshots.initialize('interaction', false)
  snapshots.loaded('canvas', initial)
  snapshots.beginPatch('canvas', JSON.stringify({nodes:{[a.id]:a},fields:{}}).replace('"opacity":1', '"opacity":-0'))()
  expect(snapshots.canFork('interaction', JSON.stringify({...doc,nodes:{[a.id]:{...a,opacity:0}}}))).toBe(false)
  snapshots.loaded('canvas', initial.replace('"opacity":1', '"opacity":-0'))
  snapshots.beginPatch('canvas', JSON.stringify({ nodes: {}, fields: { name: 'renamed' } }))()
  expect(snapshots.canFork('interaction', JSON.stringify({ ...doc, name: 'renamed' }))).toBe(false)
})


test('bounded journal coalesces only existing replacements and preserves structural order', () => {
  const snapshots = new PreparationSnapshots(), doc = blank(), a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  snapshots.initialize('canvas', false); snapshots.initialize('interaction', false)
  const initial = JSON.stringify(doc); snapshots.loaded('canvas', initial)
  let moved = a
  for (let i = 0; i < 32; i++) {
    moved = {...a, opacity: i / 32}
    snapshots.beginPatch('canvas', JSON.stringify({nodes:{[a.id]:moved},fields:{}}))()
  }
  expect(snapshots.canFork('interaction', JSON.stringify({...doc,nodes:{...doc.nodes,[a.id]:moved}}))).toBe(true)
  snapshots.loaded('canvas', initial)
  snapshots.beginPatch('canvas', JSON.stringify({nodes:{[a.id]:null},fields:{}}))()
  snapshots.beginPatch('canvas', JSON.stringify({nodes:{[a.id]:a},fields:{}}))()
  // Delete then reinsert changes object insertion order. It must not collapse
  // into an existing-node replacement with the original JSON spelling.
  expect(snapshots.canFork('interaction', initial)).toBe(false)
  expect(snapshots.canFork('interaction', JSON.stringify({...doc,nodes:{[b.id]:b,[a.id]:a}}))).toBe(true)
  snapshots.loaded('canvas', initial)
  for (let i = 0; i < 257; i++) snapshots.beginPatch('canvas', '{"nodes":{},"fields":{}}')()
  expect(snapshots.canFork('interaction', initial)).toBe(false)
  snapshots.loaded('canvas', initial)
  snapshots.beginPatch('canvas', ' '.repeat(2 * 1024 * 1024 + 1))()
  expect(snapshots.canFork('interaction', initial)).toBe(false)
})

test('source size and unknown lanes cannot create unbounded certificates', () => {
  const snapshots = new PreparationSnapshots()
  snapshots.initialize('canvas', false); snapshots.initialize('interaction', false)
  const oversized = ' '.repeat(32 * 1024 * 1024 + 1)
  snapshots.loaded('canvas', oversized)
  expect(snapshots.canFork('interaction', oversized)).toBe(false)
  snapshots.loaded('other', '{}'); snapshots.initialize('other', false)
  expect(snapshots.canFork('other', '{}')).toBe(false)
})

test('decoded image ownership survives a static fork and source disposal', () => {
  const doc = blank(), rect = node('rectangle', 0, 0, 4, 4)
  const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  rect.fills = [{...paint('#ffffff'),kind:'image',image:uri} as ReturnType<typeof paint>]
  doc.nodes[rect.id] = rect; doc.pages[0].children = [rect.id]
  const source = new VectorEngine()
  let fork: VectorEngine | undefined, freed = false
  try {
    source.load_document(JSON.stringify(doc))
    const pixels = source.image_rgba8(uri)
    fork = source.fork_static_render_engine(); expect(fork).toBeDefined()
    expect(fork!.image_rgba8(uri)).toEqual(pixels)
    source.free(); freed = true
    expect(fork!.image_rgba8(uri)).toEqual(pixels)
  } finally { if (!freed) source.free(); fork?.free() }
})
