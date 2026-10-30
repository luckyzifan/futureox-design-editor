// B02: isolated CPU/WASM measurements. This is not GPU time or canvas FPS.
// Usage: node benchmark-wasm-variants.mjs document.fd out.json binding-dir ...
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import os from 'node:os'

const [fixture, output, ...folders] = process.argv.slice(2)
if (!fixture || !output || folders.length < 2) throw Error('Expected document.fd out.json and at least two binding directories')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const input = await readFile(fixture), parsed = JSON.parse(input)
const doc = parsed.document || parsed, documentJson = JSON.stringify(doc)
const font = await readFile(new URL('../../frontend/design-client/public/fonts/NotoSansSC.ttf', import.meta.url))
const variants = []
for (const folder of folders) {
  const wasm = await readFile(resolve(folder, 'design_kernel_bg.wasm'))
  const binding = await import(pathToFileURL(resolve(folder, 'design_kernel.js')).href)
  const start = performance.now()
  await binding.default({ module_or_path: await WebAssembly.compile(wasm) })
  variants.push({ name: folder, wasmSha256: sha(wasm), wasmBytes: wasm.length, moduleMs: performance.now() - start, binding, rounds: [] })
}
const board = doc.nodes[doc.pages[0].children[0]]
const options = JSON.stringify({ pageId: doc.pages[0].id, width: 256, height: 192,
  view: { x: -board.transform[4] + .375, y: -board.transform[5] - .125, zoom: 1 },
  rasterProfile: 'figmaSubpixel', grid: false, transparent: false })
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1), samples: values }
}
let expectedPacket
for (let round = 0; round < 5; round++) {
  // Alternating order reduces the influence of thermal/runtime drift.
  const order = round % 2 ? [...variants].reverse() : variants
  for (const variant of order) {
    const engine = new variant.binding.VectorEngine()
    try {
      engine.load_font(font)
      const at = performance.now()
      engine.load_document(documentJson)
      const loadMs = performance.now() - at
      const start = performance.now(), packet = engine.compile_gpu_packet(options)
      const firstCompileMs = performance.now() - start, packetHash = sha(packet)
      expectedPacket ??= packetHash
      if (expectedPacket !== packetHash) throw Error(`Compilation output changed in ${variant.name}`)
      for (let i = 0; i < 20; i++) engine.compile_gpu_packet(options)
      const times = []
      for (let i = 0; i < 100; i++) {
        const now = performance.now(); engine.compile_gpu_packet(options); times.push(performance.now() - now)
      }
      variant.rounds.push({ round, loadMs, firstCompileMs, hotCompile: summarize(times),
        packetBytes: packet.byteLength, packetHash, cache: JSON.parse(engine.gpu_compile_cache_stats()) })
      console.log(`${variant.name} round ${round + 1}: load=${loadMs.toFixed(1)} first=${firstCompileMs.toFixed(1)} hot=${summarize(times).median.toFixed(2)} ms`)
    } finally { engine.free() }
  }
}
const result = { kind: 'wasm-cpu-compile', units: 'ms',
  note: 'Fresh Engine per round, loaded modules shared. moduleMs is one sample, not a cold-start distribution. No GPU/present or page latency is measured.',
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model },
  fixture: { sha256: sha(input), nodes: Object.keys(doc.nodes).length, fontSha256: sha(font) },
  options: JSON.parse(options), warmup: 20, samplesPerRound: 100,
  variants: variants.map(({ binding, ...data }) => data) }
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
