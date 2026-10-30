// Same-host release-WASM comparison. Run serially, switching only WASM_PATH.
// Includes newly required remeasurement and unaffected controls; retain all runs.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import initialize, { VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
const wasm = readFileSync(
  process.env.WASM_PATH ?? new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url),
)
const module = await initialize({ module_or_path: wasm }),
  engine = new VectorEngine()
engine.load_font(
  new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))),
)
const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
function measure(f: () => string) {
  for (let i = 0; i < 5; i++) f()
  const samples = [],
    batch = 4
  for (let i = 0; i < 31; i++) {
    const start = performance.now()
    for (let j = 0; j < batch; j++) f()
    samples.push((performance.now() - start) / batch)
  }
  samples.sort((a, b) => a - b)
  return { batch, samples, p50Ms: samples[15], p95Ms: samples[29] }
}
const results = []
for (const repetitions of [4, 32]) {
  const naturalLimit = repetitions * 200,
    limit = repetitions === 4 ? 65 : 503.125
  for (const kind of [
    'constrained-positive',
    'constrained-zero',
    'constrained-negative',
    'no-wrap',
    'fixed-height',
    'unconstrained',
    'min-expanded',
    'fixed-width',
  ] as const) {
    const n = {
      id: 't',
      kind: 'text',
      text: '中文AB e\u0301 '.repeat(repetitions),
      fontSize: 20,
      width: limit,
      height: 30,
      textStyle: {
        wrap: kind !== 'no-wrap',
        paragraphIndent:
          kind === 'constrained-zero' ? 0 : kind === 'constrained-negative' ? -12.375 : 25,
      },
      sizing: {
        width: kind === 'fixed-width' ? 'fixed' : 'hug',
        height: kind === 'fixed-height' ? 'fixed' : 'hug',
        minWidth: kind === 'min-expanded' ? naturalLimit : 0.01,
        maxWidth: kind === 'min-expanded' || kind === 'unconstrained' ? naturalLimit : limit,
      },
    }
    const d = JSON.stringify({
      schemaVersion: 4,
      id: 'd',
      name: 'limits',
      pages: [{ id: 'p', name: 'p', background: '#ffffff', children: ['t'] }],
      nodes: { t: n },
    })
    const output = JSON.parse(engine.resolve_layout(d))
    results.push({
      kind,
      utf16Length: n.text.length,
      ...measure(() => engine.resolve_layout(d)),
      output,
      fixedTextLayoutSha256: digest(engine.text_layout(JSON.stringify(n))),
      outputSha256: digest(JSON.stringify(output)),
      wasmLinearMemoryCapacityBytes: module.memory.buffer.byteLength,
    })
  }
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
      note: 'Shared Linux CPU, serial fresh processes. Quantiles of batch means; not browser FPS, event-latency quantiles, RSS or peak memory.',
    },
    null,
    2,
  ),
)
