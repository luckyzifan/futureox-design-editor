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
