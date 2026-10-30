// Serial same-host release-WASM CPU controls. WASM_PATH selects the saved baseline.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import initialize, { VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
const wasm = readFileSync(
  process.env.WASM_PATH ?? new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url),
)
await initialize({ module_or_path: wasm })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const results = []
for (const count of [1, 128])
  for (const kind of ['solid', 'linear'])
    for (const profile of ['analytic', 'figma']) {
      const nodes: Record<string, unknown> = {}
      const children = []
      for (let i = 0; i < count; i++) {
        const id = `n${i}`
        children.push(id)
        nodes[id] = {
          id,
          kind: 'rectangle',
          width: count === 1 ? 50 : 4,
          height: count === 1 ? 50 : 4,
          transform: [1, 0.125, 0.25, 1, (i % 16) * 3 + 0.25, Math.floor(i / 16) * 5 + 0.5],
          fills: [
            {
              kind,
              color: '#224466',
              angle: 37,
              stops: [
                { offset: 0, color: '#ff0000' },
                { offset: 1, color: '#0000ff' },
              ],
            },
          ],
        }
      }
      const engine = new VectorEngine()
      try {
        engine.load_document(
          JSON.stringify({
            schemaVersion: 4,
            id: 'd',
            name: 'Inverse performance controls',
            pages: [{ id: 'p', name: 'p', background: '#ffffff', children }],
            nodes,
          }),
        )
        const options = JSON.stringify({
          pageId: 'p',
          width: 64,
          height: 64,
          view: { x: 0.125, y: 0.375, zoom: 1 },
          transparent: true,
          rasterProfile: profile,
        })
        const expected = engine.render_rgba(options)
        for (let i = 0; i < 5; i++) engine.render_rgba(options)
        const samples = [],
          batch = 4
        for (let i = 0; i < 31; i++) {
          const start = performance.now()
          for (let j = 0; j < batch; j++) engine.render_rgba(options)
          samples.push((performance.now() - start) / batch)
        }
        samples.sort((a, b) => a - b)
        results.push({
          count,
          kind,
          profile,
          samples,
          batch,
          p50Ms: samples[15],
          p95Ms: samples[29],
          pixelsSha256: hash(expected),
        })
      } finally {
        engine.free()
      }
    }
console.log(
  JSON.stringify(
    {
      wasmSha256: hash(wasm),
      wasmBytes: wasm.length,
      runtime: process.version,
      bunVersion: process.versions.bun,
      warmups: 5,
      samples: 31,
      results,
      note: 'Same shared Linux CPU; serial fresh processes. Quantiles of four-render batch means, not browser FPS, production event latency, RSS or peak memory.',
    },
    null,
    2,
  ),
)
