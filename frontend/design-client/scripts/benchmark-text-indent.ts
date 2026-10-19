// Same-process real release-WASM text calls; switch only WASM_PATH for comparison.
// Linear-memory capacity is observed after each case, not process peak allocation.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import initialize, { VectorEngine } from '../src/generated/design-kernel/design_kernel.js'

const wasm = readFileSync(
  process.env.WASM_PATH ?? new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url),
)
const module = await initialize({ module_or_path: wasm })
const engine = new VectorEngine()
engine.load_font(
  new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))),
)
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function measure(f: () => string, batch: number) {
  for (let i = 0; i < 5; i++) f()
  const samples = []
  for (let i = 0; i < 31; i++) {
    const start = performance.now()
    for (let j = 0; j < batch; j++) f()
    samples.push((performance.now() - start) / batch)
  }
  samples.sort((a, b) => a - b)
  return { p50Ms: samples[15], p95Ms: samples[29], batch, samples }
}
const results = []
for (const repetitions of [4, 32]) {
  for (const indent of [0, 12.375, -12.375]) {
    const node = {
      id: 't',
      kind: 'text',
      text: '中文AB e\u0301 '.repeat(repetitions),
      fontSize: 20,
      width: 503.125,
      height: 30,
      textStyle: { wrap: true, paragraphIndent: indent },
    }
    const json = JSON.stringify(node)
    const output = JSON.parse(engine.text_layout(json))
    results.push({
      operation: 'fixed-layout-and-outlines',
      utf16Length: node.text.length,
      indent,
      ...measure(() => engine.text_layout(json), repetitions === 4 ? 4 : 1),
      width: output.width,
      height: output.height,
      lines: output.lines.length,
      geometrySha256: digest(
        JSON.stringify({
          glyphs: output.glyphs,
          spans: output.spans,
          bounds: output.bounds,
          lines: output.lines,
        }),
      ),
      wasmLinearMemoryCapacityBytes: module.memory.buffer.byteLength,
    })
  }
}
for (const indent of [0, 12.375, 20.3]) {
  const document = JSON.stringify({
    schemaVersion: 4,
    id: 'd',
    name: 'text',
    pages: [{ id: 'p', name: 'p', children: ['t'], background: '#ffffff' }],
    nodes: {
      t: {
        id: 't',
        kind: 'text',
        text: '中文AB',
        fontSize: 20,
        width: 500,
        height: 30,
        textStyle: { wrap: true, paragraphIndent: indent },
        sizing: { width: 'hug', height: 'hug' },
      },
    },
  })
  results.push({
    operation: 'hug-resolve-measure-only',
    indent,
    ...measure(() => engine.resolve_layout(document), 8),
    output: JSON.parse(engine.resolve_layout(document)),
    wasmLinearMemoryCapacityBytes: module.memory.buffer.byteLength,
  })
}
engine.free()
console.log(
  JSON.stringify(
    {
      wasmSha256: digest(wasm),
      wasmBytes: wasm.length,
      runtime: process.version,
      bunVersion: process.versions.bun,
      executable: process.execPath,
      samples: 31,
      warmups: 5,
      results,
      note: 'Shared Linux cloud; serial runs. p50/p95 of batch-average calls, not event latency, FPS or peak memory.',
    },
    null,
    2,
  ),
)
