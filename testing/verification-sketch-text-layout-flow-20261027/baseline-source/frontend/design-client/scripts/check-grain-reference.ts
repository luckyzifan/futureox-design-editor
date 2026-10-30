/** Re-render the six frozen external PNG controls; report differences, never
 * re-label internal CPU/GPU equality as external reference equivalence. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import init, { VectorEngine, texture_material_field } from '../src/generated/design-kernel/design_kernel.js'
import { blank, node, paint, effect } from '../src/model'
const output = mkdtempSync(join(tmpdir(), 'forma-grain-reference-'))
const wasm = readFileSync(new URL('../src/generated/design-kernel/design_kernel_bg.wasm', import.meta.url))
await init({ module_or_path: wasm })
const root = new URL('../public/fidelity/texture-ramps-2026-10-08/', import.meta.url)
const provenance = JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8'))
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
for (const [file, sha] of Object.entries(provenance.files))
  if (hash(readFileSync(new URL(file, root))) !== sha) throw Error(`Changed external reference: ${file}`)
const rows = []
const live = JSON.parse(readFileSync(new URL('../../../testing/fixtures/design/figma-texture-ramps-live-2026-10-13.json', import.meta.url), 'utf8'))
for (const axis of ['x', 'y']) for (const size of [0, 8, 16]) {
  const name = `TextureRamp-${axis}-${size}`
  const d = blank(name), frame = node('frame', 0, 0, 256, 256), shape = node('rectangle', 0, 0, 256, 256)
  d.schemaVersion = 10
  const reference = live.rows.find((r: { name: string }) => r.name === name)
  if (!reference || reference.width !== 256 || reference.height !== 256) throw Error('Missing actual reference geometry')
  const x = reference.absoluteTransform[0][2], y = reference.absoluteTransform[1][2]
  frame.transform[4] = x; frame.transform[5] = y
  frame.fills = []; frame.clip = true
  const p = paint('#000000', 'linear')
  p.angle = 0; p.transform = axis === 'x' ? [1, 0, 0, 1, 0, 0] : [0, 1, -1, 0, 1, 0]
  p.stops = [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]
  shape.fills = [p]
  if (size) shape.effects = [{ ...effect('texture'), radius: 64, opacity: 1, texture: { noiseSize: [size, size], clipToShape: false } }]
  if (size) writeFileSync(join(output, `${name}-field.f32`), new Uint8Array(texture_material_field(JSON.stringify({x:0,y:0,w:256,h:256}), new Float64Array([1,0,0,1,0,0]), JSON.stringify(shape.effects[0]), 128, 128).buffer))
  frame.children = [shape.id]; d.nodes = { [frame.id]: frame, [shape.id]: shape }; d.pages[0].children = [frame.id]
  for (const profile of ['figma', 'figmaSoftware', 'analytic'] as const) {
    console.log(`GRAIN_RENDER ${name}/${profile}`)
    d.rasterProfile = profile
    const engine = new VectorEngine()
    try {
      engine.load_document(JSON.stringify(d))
      const options = { pageId: d.pages[0].id, width: 256, height: 256, view: { x: -x, y: -y, zoom: 1 }, grid: false, transparent: true, rasterProfile: profile }
      const png = engine.render_png(JSON.stringify(options))
      writeFileSync(join(output, `${name}-${profile}.png`), png)
      writeFileSync(join(output, `${name}-${profile}.json`), JSON.stringify(d))
      rows.push({ name, axis, size, profile, sha256: hash(png) })
    } catch (error) { rows.push({ name, axis, size, profile, error: String(error) }) }
    finally { engine.free() }
  }
}
writeFileSync(join(output, 'inputs.json'), JSON.stringify({ wasm: hash(wasm), reference: provenance, rows }, null, 2))
const result = spawnSync('python3', [new URL('./compare-grain-reference.py', import.meta.url).pathname, output, root.pathname], { encoding: 'utf8' })
process.stdout.write(result.stdout); process.stderr.write(result.stderr)
console.log(JSON.stringify({ output, status: result.status === 0 ? 'compared' : 'failed' }))
if (result.status !== 0) process.exit(result.status ?? 1)
