import { beforeAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { importFig } from './import-fig'
import { initializePicking, kernelLayout } from './kernel/picking'
import { blank, node, effect, demo, validateDocument } from './model'
import { Editor } from './engine'

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

test('actual Figma local file preserves independent glass and anisotropic texture parameters', async () => {
  const bytes = await readFile(
    new URL(
      '../../../testing/fixtures/design/figma-materials-native-2026-10-08.fig',
      import.meta.url,
    ),
  )
  const { document } = importFig(bytes)
  const child = (frameName: string) => {
    const frame = Object.values(document.nodes).find((n) => n.name === frameName)!
    expect(frame).toBeDefined()
    return document.nodes[frame.children.at(-1)!]
  }
  expect(child('MaterialQA-depth-24').effects[0].glass).toEqual({
    depth: 24,
    refraction: 0.5,
    dispersion: 0,
    lightAngle: 45,
    lightIntensity: 0,
  })
  expect(child('MaterialQA-texture-anisotropic').effects[0].texture).toEqual({
    noiseSize: [8, 16],
    clipToShape: true,
  })
  expect(child('MaterialQA-texture-unclipped').effects[0].texture?.clipToShape).toBe(false)
  expect(child('BlurQA-0p5').effects[0].kind).toBe('blur')
  expect(document.schemaVersion).toBe(16)
  expect(Object.values(document.nodes).some(n=>n.vectorGeometry!==undefined)).toBe(true)
  const resolved = kernelLayout(document)
  expect(() => validateDocument(resolved)).not.toThrow()
  const loaded = JSON.parse(JSON.stringify(resolved))
  expect(
    Object.values(loaded.nodes).some((n: any) =>
      n.effects.some((e: any) => e.texture?.noiseSize[1] === 16),
    ),
  ).toBe(true)
})

test('newly authored effects expose the full material controls', () => {
  expect(effect('glass').glass).toEqual({
    depth: 8,
    refraction: 0.5,
    dispersion: 0.3,
    lightAngle: 45,
    lightIntensity: 0.5,
  })
  expect(effect('texture').texture).toEqual({ noiseSize: [8, 8], clipToShape: true })
  expect(demo().schemaVersion).toBe(5)
  expect(()=>kernelLayout(demo())).not.toThrow()
})

test('material editing upgrades the schema and undo restores the previous parameters', () => {
  const doc = blank()
  const n = node('rectangle', 0, 0, 32, 32)
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  const editor = new Editor(doc)
  editor.update(
    [n.id],
    (n) => {
      n.effects = [effect('glass')]
    },
    '玻璃',
  )
  expect(editor.state.doc.schemaVersion).toBe(5)
  editor.update(
    [n.id],
    (n) => {
      n.effects[0].glass!.depth = 24
      n.effects[0].glass!.dispersion = 0.75
    },
    '玻璃参数',
  )
  expect(editor.state.doc.nodes[n.id].effects[0].glass?.depth).toBe(24)
  editor.undo()
  expect(editor.state.doc.nodes[n.id].effects[0].glass?.depth).toBe(8)
  editor.redo()
  expect(editor.state.doc.nodes[n.id].effects[0].glass?.dispersion).toBe(0.75)
  expect(() => validateDocument(JSON.parse(JSON.stringify(editor.state.doc)))).not.toThrow()
})
