/** Actual four-phase mask oracle. No renderer, canonical sample selection or
 * equivalent-coverage cache participates in the reference. Real documents and
 * raw coverage words remain private; results contain only numbers and hashes. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { identicalSampleCoverage } from '../src/kernel/gpu/sample-equivalent-coverage'
import type { PathMesh, Rect } from '../src/kernel/gpu/types'
import { project, repository, runProof, sha256 } from './exact-prefix-proof-utils'

type Span = [number, number, number, number, number, number]
type Fixture = { name: string; classification: 'accepted' | 'declared-different' | 'unknown'; path: PathMesh;
  curves: number[]; regions: Rect[]; privateReal?: true }
const bound = {
  sceneSha256: '91b7d963a027bf556c7eddad3ee593260431ab15114a89c5cf313913612bb7d1',
  documentSha256: 'a0d0df3b24ea187dfd5723c9d41ab17908ce22afebb0bf64592f749d6fac3677',
  requestFileSha256: 'f38710da2551f6a338b009e77a6edb6ce18b050537f56137de7f40460976ca6a',
  executionRequestSha256: 'e3fc7bdc92eaf921c387843b8d4448e603c2813c656f8fd3433b1cc84448cba7',
  wasmSha256: '4efb26d67f71bf031fed9efbdfe3ea15385c57017de46aa5fd465a13136679a9',
}
const scenePath = resolve(process.env.DESIGN_COVERAGE_SCENE || '/tmp/futureox-gpu-waits-117-phase3-64-scene.json')
const documentPath = resolve(process.env.DESIGN_COVERAGE_DOCUMENT || join(repository,
  'testing/verification-complex-navigation-20261021/verified-stress-117/fixture-document.json'))
const requestPath = resolve(process.env.DESIGN_COVERAGE_REQUESTS || join(repository,
  'testing/verification-complex-navigation-20261021/reference-roi-preflight/real-region-117-request-v1.json'))
const fontPath = join(project, 'public/fonts/NotoSansSC.ttf')
function regions(r: Rect): Rect[] {
  return [
    { x: r.x, y: r.y, w: Math.min(3, r.w), h: Math.min(2, r.h) },
    { x: r.x + Math.min(1, r.w - 1), y: r.y + Math.min(1, r.h - 1), w: Math.min(17, Math.max(1, r.w - 1)), h: Math.min(5, Math.max(1, r.h - 1)) },
    { x: r.x + r.w - Math.min(7, r.w), y: r.y + r.h - Math.min(3, r.h), w: Math.min(7, r.w), h: Math.min(3, r.h) },
  ]
}
function program(name: string, classification: Fixture['classification'], width: number, rows: Span[][][]): Fixture {
  const curves = [3, 1, width, rows.length], headers = 1 + rows.length * 4
  curves.length = headers * 4; curves.fill(0, 4)
  const words = (value: number) => {
    const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, true)
    return Array.from({ length: 4 }, (_, i) => view.getUint16(i * 2, true))
  }
  for (let row = 0; row < rows.length; row++) for (let phase = 0; phase < 4; phase++) {
    const spans = rows[row][phase], at = (1 + row * 4 + phase) * 4
    curves[at] = curves.length / 4; curves[at + 1] = spans.length
    for (const span of spans) curves.push(...span.slice(0, 4), ...words(span[4]), ...words(span[5]))
  }
  const path: PathMesh = { rect: { x: -100, y: 200, w: width, h: rows.length }, sampleCount: 4, count: 3,
    first: 0, rule: 'nonzero', area: { first: 0, count: curves.length / 4 } }
  return { name, classification, path, curves, regions: regions(path.rect) }
}
const repeat = (spans: Span[]): Span[][] => Array.from({ length: 4 }, () => spans.map(span => [...span] as Span))
function synthetics(): Fixture[] {
  const result = [
    program('partial-and-empty-rows', 'accepted', 12, [repeat([[2, 6, 0, 0, .0625, .0625]]), repeat([])]),
    program('same-raw-spans-offsets-separate', 'declared-different', 12, [repeat([[2, 6, 0, 0, .5, .5]])]),
    program('different-programs-same-integer-runs', 'accepted', 12, [[
      [[1, 3, 0, 0, .2, .2]], [[0, 2, 0, 0, .9, .9]],
      [[1, 2, 0, 0, .1, .9]], [[1, 2, 0, 0, .6, .9]],
    ]]),
    program('overlap-run-minimum-does-not-retreat', 'accepted', 12, [[
      [[2, 5, 0, 0, .5, 0], [2, 6, 0, 0, 0, 0]],
      [[2, 6, 0, 0, 0, 0]], [[2, 6, 0, 0, 0, 0]], [[2, 6, 0, 0, 0, 0]],
    ]]),
    program('endpoint-adjust-retreat-negative', 'declared-different', 12, [[
      [[2, 5, 0, 0, .5, 0], [2, 6, 0, 0, 0, 0]],
      [[3, 6, 0, 0, 0, 0]], [[3, 6, 0, 0, 0, 0]], [[3, 6, 0, 0, 0, 0]],
    ]]),
    program('signed-zero-endpoint-order', 'accepted', 12, [repeat([[2, 6, 0, 0, -0, 0]])]),
    program('negative-upper-phase-split', 'declared-different', 12, [repeat([[2, 6, -1, 0, 1.25, 0]])]),
    program('single-pixel-both-endpoints', 'declared-different', 12, [repeat([[2, 2, 0, 0, .2, .8]])]),
  ]
  const ordered = repeat(Array.from({ length: 17 }, (_, i) => [i * 3, i * 3 + 1, 0, 0, 0, 0] as Span))
  result.push(program('seventeen-span-binary-search', 'accepted', 56, [ordered]))
  const changed = structuredClone(ordered); changed[0][16][4] = .5
  result.push(program('seventeen-span-final-endpoint-split', 'declared-different', 56, [changed]))
  const nonzero = program('nonzero-program-storage-offset', 'accepted', 12, [repeat([[2, 6, 0, 0, .0625, .0625]])])
  nonzero.curves.unshift(...new Array(12).fill(123.5)); nonzero.path.area!.first = 3; result.push(nonzero)
  const countUnknown = program('unsupported-sample-count-equal-allowed', 'unknown', 12, [repeat([[2, 6, 0, 0, .0625, .0625]])])
  countUnknown.path.sampleCount = 16; result.push(countUnknown)
  const budget = program('aliased-row-span-work-budget', 'unknown', 8192,
    [repeat(Array.from({ length: 4096 }, (_, i) => [i * 2, i * 2, 0, 0, 0, 1] as Span))])
  const first = budget.curves[4], count = budget.curves[5], tail = budget.curves.slice(first * 4), headerWords = (1 + 64 * 4) * 4
  budget.path.rect.h = 64; budget.curves[3] = 64; budget.curves.length = headerWords; budget.curves.fill(0, 4)
  for (let record = 0; record < 64 * 4; record++) {
    budget.curves[4 + record * 4] = headerWords / 4; budget.curves[5 + record * 4] = count
  }
  budget.curves.push(...tail); budget.path.area!.count = budget.curves.length / 4
  budget.regions = regions(budget.path.rect); result.push(budget)
  return result
}

await runProof('futureox-sample-coverage', [scenePath, documentPath, requestPath, fontPath], async proof => {
  const [sceneBytes, documentBytes, requestBytes, wasm, font] = await Promise.all([
    readFile(scenePath), readFile(documentPath), readFile(requestPath), readFile(join(project, 'public/kernel/design_kernel_bg.wasm')), readFile(fontPath),
  ])
  const requested = JSON.parse(requestBytes.toString()), request = { ...requested[0], gpuPainterSupport: true }
  const hashes = { sceneSha256: sha256(sceneBytes), documentSha256: sha256(documentBytes), requestFileSha256: sha256(requestBytes),
    executionRequestSha256: sha256(JSON.stringify(request)), wasmSha256: sha256(wasm) }
  for (const key of Object.keys(bound) as (keyof typeof bound)[]) if (hashes[key] !== bound[key]) throw Error(`Bound regression ${key} changed`)
  initSync({ module: wasm })
  const engine = new VectorEngine()
  let compiled: string
  try { engine.load_font(font); engine.load_document(documentBytes.toString()); compiled = engine.compile_gpu(JSON.stringify(request)) }
  finally { engine.free() }
  if (sha256(compiled!) !== bound.sceneSha256) throw Error('Fresh native compile is not the bound original regression scene')
  const scene = JSON.parse(compiled!), curves = new Float32Array(scene.curves)
  const candidates = Object.values(scene.nodes).flatMap((n: any) => [n.fill, ...n.strokes.map((s: any) => s.path)])
    .filter((path: PathMesh) => identicalSampleCoverage(path, curves))
  const unique = new Map<string, PathMesh>()
  for (const path of candidates) unique.set(sha256(JSON.stringify(path)), path)
  const selected = [...unique].sort((a, b) => b[1].rect.w * b[1].rect.h - a[1].rect.w * a[1].rect.h).slice(0, 3)
  if (!selected.length) throw Error('The bound 117 scene contains no admitted four-phase coverage source')
  const fixtures = synthetics()
  selected.forEach(([pathSha256, path], i) => fixtures.push({ name: `bound-117-accepted-${i + 1}`, classification: 'accepted', path,
    curves: scene.curves, regions: regions(path.rect), privateReal: true }))
  const summaries = fixtures.map(f => {
    const admitted = identicalSampleCoverage(f.path, new Float32Array(f.curves))
    if (admitted !== (f.classification === 'accepted')) throw Error(`Unexpected helper certificate for ${f.name}`)
    return { name: f.name, classification: f.classification, admitted, width: f.path.rect.w, height: f.path.rect.h,
      programWords: f.path.area!.count * 4, pathSha256: sha256(JSON.stringify(f.path)),
      programSha256: sha256(new Uint8Array(new Float32Array(f.curves).buffer)), regionCount: f.regions.length }
  })
  const manifest = { ...hashes, fontSha256: sha256(font), freshNativeCompileMatched: true, candidatePathCount: candidates.length,
    uniqueCandidateCount: unique.size, selectedPathCount: selected.length, fixtures: summaries,
    scope: 'Independent original four-phase WebGpuDriver R32 mask/maskRegion; no renderer canonicalization; raw words stay private' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return { ...manifest, gpuExecuted: false }
  return proof.browser(async page => {
    let progress = 0
    await page.exposeFunction('coverageProgress', (value: unknown) => proof.write(`progress-${String(++progress).padStart(3, '0')}.json`, value))
    return page.evaluate(async payload => {
      const report = (value: unknown) => (globalThis as any).coverageProgress(value) as Promise<void>
      const { initializeKernelModule } = await import('/src/kernel/module.ts')
      const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
      const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
      const { identicalSampleCoverage } = await import('/src/kernel/gpu/sample-equivalent-coverage.ts')
      const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer))]
        .map(v => v.toString(16).padStart(2, '0')).join('')
      await initializeKernelModule()
      const wasm = new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())
      const font = new Uint8Array(await (await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
      if (await digest(wasm) !== payload.manifest.wasmSha256 || await digest(font) !== payload.manifest.fontSha256)
        throw Error('Browser WASM/font differs from bound native compile')
      const engine = new VectorEngine(); let native: string
      try { engine.load_font(font); engine.load_document(JSON.stringify(payload.document)); native = engine.compile_gpu(JSON.stringify(payload.request)) }
      finally { engine.free() }
      if (await digest(new TextEncoder().encode(native!)) !== payload.manifest.sceneSha256) throw Error('Browser native compile changed the bound regression scene')
      const driver = await WebGpuDriver.create(true, false, true, true, false), raw = driver as any, device = raw.device as GPUDevice
      const info = device.adapterInfo
      if (info.isFallbackAdapter !== false) throw Error('Confirmed actual non-fallback GPU required')
      const adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter }
      const records: any[] = []; let current = 'prepare-area', comparedWords = 0, accepted = 0, negatives = 0, unknown = 0
      await report({ phase: current, adapter, maxTextureDimension2D: device.limits.maxTextureDimension2D, freshNativeCompileMatched: true })
      // Prepare only the production registered area pipeline; upload literal
      // program words. No scene residency or renderer sample rewriting occurs.
      await raw.pipelines.prepare(['area'])
      async function readWords(target: any): Promise<Uint32Array> {
        if (!target.scalarCoverage || (target.resource as GPUTexture).format !== 'r32float') throw Error('Reference target is not raw R32 coverage')
        await driver.checkpoint('readback')
        const stride = Math.ceil(target.width * 4 / 256) * 256
        const buffer = device.createBuffer({ size: stride * target.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        try {
          const encoder = device.createCommandEncoder()
          encoder.copyTextureToBuffer({ texture: target.resource }, { buffer, bytesPerRow: stride }, [target.width, target.height])
          device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
          const mapped = new Uint32Array(buffer.getMappedRange()), words = new Uint32Array(target.width * target.height)
          for (let y = 0; y < target.height; y++) words.set(mapped.subarray(y * stride / 4, y * stride / 4 + target.width), y * target.width)
          buffer.unmap(); return words
        } finally { buffer.destroy() }
      }
      const wordHash = (words: Uint32Array) => digest(new Uint8Array(words.buffer, words.byteOffset, words.byteLength))
      try {
        for (const f of payload.fixtures) {
          current = f.name
          const path = f.path as any, curves = new Float32Array(f.curves), certified = identicalSampleCoverage(path, curves)
          if (certified !== (f.classification === 'accepted')) throw Error(`Certificate changed for ${f.name}`)
          driver.begin(new Float32Array(0), curves)
          let baseline: Uint32Array | undefined, phaseDifferences = 0, regionDifferences = 0, regionWords = 0
          const phaseHashes: string[] = []
          for (let phase = 0; phase < 4; phase++) {
            const target = driver.createScalarCoverage(path.rect.w, path.rect.h)
            let words: Uint32Array
            try { driver.mask(path, target, phase); words = await readWords(target) }
            finally { driver.destroy(target) }
            if (words!.some(word => word !== 0 && word !== 0x3f800000)) throw Error(`Nonbinary raw coverage in ${f.name}`)
            phaseHashes.push(await wordHash(words!))
            if (!baseline) baseline = words!
            else for (let i = 0; i < words!.length; i++) if (words![i] !== baseline[i]) phaseDifferences++
            comparedWords += words!.length
            for (const region of f.regions) {
              const target = driver.createScalarCoverage(region.w, region.h)
              let crop: Uint32Array
              try { driver.maskRegion(path, target, phase, region); crop = await readWords(target) }
              finally { driver.destroy(target) }
              for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
                if (crop![y * region.w + x] !== words![(region.y - path.rect.y + y) * path.rect.w + region.x - path.rect.x + x]) regionDifferences++
              }
              regionWords += crop!.length
            }
          }
          const validation = await device.popErrorScope(); raw.frameScopeOpen = false
          if (validation) throw Error(validation.message)
          if (regionDifferences) throw Error(`Regional direct mask differs from its original phase crop in ${f.name}`)
          if (certified && phaseDifferences) throw Error(`False positive coverage certificate in ${f.name}`)
          if (f.classification === 'declared-different' && (!phaseDifferences || certified)) throw Error(`Negative control failed in ${f.name}`)
          if (certified) accepted++; else if (f.classification === 'declared-different') negatives++; else unknown++
          const record = { name: f.name, classification: f.classification, certified, width: path.rect.w, height: path.rect.h,
            phaseHashes, phaseDifferentWords: phaseDifferences, fullMaskWords: path.rect.w * path.rect.h * 4,
            regionDifferentWords: regionDifferences, regionWords, rawFormat: 'r32float', rawLane: 'r', rendererCanonicalization: false }
          records.push(record); await report({ phase: 'case-passed', record, completedCases: records.length })
        }
        return { adapter, cases: records, accepted, declaredDifferent: negatives, unknownDeclined: unknown,
          comparedWords, rawFormat: 'r32float', freshBrowserNativeCompileMatched: true,
          limitation: 'Independent mask operator proof; no whole-scene color, latency, editing, undo or export acceptance' }
      } catch (error) { await report({ phase: 'failed', current, error: String(error), records }); throw error }
      finally { driver.dispose() }
    }, { fixtures, manifest, document: JSON.parse(documentBytes.toString()), request })
  })
})
