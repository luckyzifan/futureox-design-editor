/** Original mode2 -> mode3 reference versus the renderer's narrowly certified
 * image-over-transparent identity. This is an operator/raw-bit proof, not an
 * application memory, export, interaction or latency acceptance result. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { project, repository, runProof, sha256 } from './exact-prefix-proof-utils'

if (process.env.VITE_DESIGN_EXACT_CLAMP_PREFIX !== '1' || process.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE === '0')
  throw Error('Run with VITE_DESIGN_EXACT_CLAMP_PREFIX=1 and actual upload range certificates enabled')
const scenePath = resolve(process.env.DESIGN_IMAGE_IDENTITY_SCENE || '/tmp/futureox-gpu-waits-117-phase3-64-scene.json')
const documentPath = resolve(process.env.DESIGN_IMAGE_IDENTITY_DOCUMENT || join(repository,
  'testing/verification-complex-navigation-20261021/verified-stress-117/fixture-document.json'))
const names = ['opaque-full', 'opaque-binary-holes', 'signed-zero-subnormal', 'contain-invalid',
  'decline-transparent', 'decline-negative', 'decline-hdr', 'decline-unknown-upload', 'decline-opacity',
  'decline-float-mask', 'decline-clip', 'decline-fractional-destination', 'decline-extent', 'decline-stage', 'bound-117-native-window']

await runProof('futureox-image-zero-over', [scenePath, documentPath], async proof => {
  const [sceneBytes, documentBytes, wasm] = await Promise.all([readFile(scenePath), readFile(documentPath),
    readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))])
  const scene = JSON.parse(sceneBytes.toString()), document = JSON.parse(documentBytes.toString())
  const node = Object.values(scene.nodes).find((n: any) => n.fills.length === 1 && n.fills[0].kind === 'image' &&
    !n.children.length && !n.effects.length && n.size[0] === 1393) as any
  if (sha256(sceneBytes) !== '91b7d963a027bf556c7eddad3ee593260431ab15114a89c5cf313913612bb7d1' ||
      sha256(wasm) !== '4efb26d67f71bf031fed9efbdfe3ea15385c57017de46aa5fd465a13136679a9' ||
      !node || node.fills[0].adjust || node.fills[0].image !== document.nodes[node.id]?.fills[0]?.image)
    throw Error('Bound actual117 native source/program changed')
  const manifest = { sceneSha256: sha256(sceneBytes), documentSha256: sha256(documentBytes), wasmSha256: sha256(wasm),
    actualImagePaintSha256: sha256(JSON.stringify(node.fills[0])), names, samplesPerFixture: 4,
    reference: 'Independent original driver mode2 paint followed by driver mode3 over a full-size cleared texture; never calls paintOver.',
    candidate: 'Actual GpuRenderer.paintOver with private uploaded image proof and actual mode3/bypass witnesses.',
    operatorWorkingBudgetMiB: 512,
    scope: 'Bounded exact operator comparison, actual native image/coordinates and controlled coverage. Not a product budget, whole-document or latency gate.' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return { ...manifest, gpuExecuted: false }
  return proof.browser(async page => {
    let progress = 0
    await page.exposeFunction('imageIdentityProgress', (record: unknown) => proof.write(`progress-${String(++progress).padStart(3, '0')}.json`, record))
    return page.evaluate(async payload => {
      const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
      const { GpuRenderer } = await import('/src/kernel/gpu/renderer.ts')
      const { parameters } = await import('/src/kernel/gpu/types.ts')
      const { initializeKernelModule } = await import('/src/kernel/module.ts')
      const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
      type Texture = import('/src/kernel/gpu/types.ts').Texture
      const digest = async (value: Float32Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)))).map(n => n.toString(16).padStart(2, '0')).join('')
      const wasm = new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())
      const actualWasm = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasm))).map(n => n.toString(16).padStart(2, '0')).join('')
      if (actualWasm !== payload.manifest.wasmSha256) throw Error('Browser WASM does not match the bound fixture')
      await initializeKernelModule()
      const engine = new VectorEngine(); engine.load_document(JSON.stringify(payload.document))
      const driver = await WebGpuDriver.create(true, false, true, true, false), device = (driver as any).device
      const permanent = new Set<Texture>((driver as any).textures), records: any[] = []
      let rawComponents = 0, bypasses = 0, peakTextureBytes = 0
      try {
        for (const name of payload.names) {
          const actual = name === 'bound-117-native-window'
          const r = actual ? { ...payload.scene.output } : { x: -19, y: 23, w: 64, h: 48 }
          // Synthetic linear pixels come from the explicit test loader. Keep
          // its resource key inside the production data-image URI contract.
          const p = actual ? { ...payload.node.fills[0] } : { kind: 'image',
            image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVgAAAABJRU5ErkJggg==', color: '#ffffff',
            fit: name === 'contain-invalid' ? 'contain' : 'stretch', opacity: 1, blend: 'normal', visible: true, stops: [] }
          if (name === 'decline-opacity') p.opacity = .5
          const dims = actual ? JSON.parse(engine.image_info_at_level(p.image, 0)) : [7, 5]
          const pixels = actual ? engine.image_linear_at_level(p.image, 0) : new Float32Array(dims[0] * dims[1] * 4)
          if (!actual) {
            const words = new Uint32Array(pixels.buffer)
            for (let i = 0; i < dims[0] * dims[1]; i++) for (let c = 0; c < 4; c++) {
              pixels[i * 4 + c] = c === 3 ? 1 : ((i * 17 + c * 11) % 251) / 256
              if (name === 'signed-zero-subnormal' && c < 3) words[i * 4 + c] = [0, 0x80000000, 1, 0x007fffff, 0x00800001][(i + c) % 5]
              if (name === 'decline-transparent' && c === 3) pixels[i * 4 + c] = i % 2 ? .5 : 0
              if (name === 'decline-negative' && c < 3) pixels[i * 4 + c] *= -1
              if (name === 'decline-hdr' && c < 3) pixels[i * 4 + c] = 2 + c
            }
          }
          const n = actual ? { ...payload.node, rect: r, fills: [p] } : { id: 'fixture-image', rect: r,
            matrix: [1, 0, 0, 1, r.x, r.y], inverse: [1, 0, 0, 1, -r.x, -r.y], size: [r.w, r.h],
            children: [], effects: [], strokes: [], fills: [p], opacity: 1, blend: 'normal',
            fill: { first: 0, count: 0, rect: r, rule: 'nonzero' } }
          if (name === 'contain-invalid') n.matrix = [.1, 0, 0, .1, r.x + 15, r.y + 10]
          const input = { version: 8, width: r.w, height: r.h, extent: r, output: r,
            rootInputBox: name === 'decline-stage' ? undefined : [r.x, r.y, r.w, r.h], coherentSamples: true,
            floatCompositing: true, nodes: { image: n }, roots: ['image'], curves: actual ? payload.scene.curves : [],
            vertices: [], view: { x: 0, y: 0, zoom: 1 }, displayImageSource: false }
          const renderer = new GpuRenderer(driver, true, false, () => ({ width: dims[0], height: dims[1], pixels }),
            false, false, payload.manifest.operatorWorkingBudgetMiB) as any
          renderer.scene = input
          await driver.prepareScene(input as any)
          driver.begin(new Float32Array(0), new Float32Array(input.curves))
          let candidateMode3 = 0, candidatePaint: Texture | undefined, observing = false, sourceCertificate = false
          const oldPass = driver.pass.bind(driver) as (...args: any[]) => void, oldPaint = renderer.paint.bind(renderer)
          driver.pass = ((target: Texture, u: Float32Array, ...args: any[]) => {
            if (observing && u[16] === 3) candidateMode3++
            if (observing && u[16] === 2) candidatePaint = target
            return oldPass(target, u, ...args)
          }) as typeof driver.pass
          renderer.paint = (...args: any[]) => {
            const value = oldPaint(...args); sourceCertificate = value.imageZeroOverIdentity === true; return value
          }
          let safe = false
          try {
            const image = renderer.imageFor(p.image), ir = image.rect
            if (name === 'decline-unknown-upload') {
              const write = parameters(ir); write[16] = 12; write.set([.25, .5, .75, 1], 48)
              driver.pass(image.texture, write, [])
              if (driver.imageTableRange(image.texture)) throw Error('Written source retained its upload certificate')
            }
            for (let sample = 0; sample < 4; sample++) {
              renderer.sampleIndex = sample
              const mask = name === 'decline-float-mask' ? driver.create(r.w, r.h) : driver.createBinaryCoverage(r.w, r.h)
              if (actual) {
                driver.maskRegion(n.fill, mask, sample, r)
                if ((await driver.readSurface(mask)).some(value => value !== 1)) throw Error('Bound native image window is not fully covered')
              }
              else if (name === 'decline-float-mask') {
                const data = new Float32Array(r.w * r.h * 4).fill(.5)
                device.queue.writeTexture({ texture: mask.resource }, data, { bytesPerRow: r.w * 16 }, [r.w, r.h])
              } else {
                const data = new Uint8Array(r.w * r.h * 4)
                for (let pixel = 0; pixel < r.w * r.h; pixel++) data.fill(
                  name === 'opaque-binary-holes' && (pixel + sample) % 7 === 0 ? 0 : 255, pixel * 4, pixel * 4 + 4)
                device.queue.writeTexture({ texture: mask.resource }, data, { bytesPerRow: r.w * 4 }, [r.w, r.h])
              }
              const coverage = { texture: mask, rect: r }, field = renderer.imageGrid(n, p, image)
              const destination = name === 'decline-fractional-destination' ? { ...r, x: r.x + .25 } :
                name === 'decline-extent' ? { ...r, w: r.w + 1 } : r
              const clip = name === 'decline-clip' ? coverage : undefined
              // Independent old path: its full clear and mode3 are always
              // encoded, regardless of any new source Surface certificate.
              const oldSource = driver.create(r.w, r.h), empty = driver.create(destination.w, destination.h)
              const reference = driver.create(destination.w, destination.h); driver.clear(empty)
              const paintUniform = parameters(r, r, ir, r); paintUniform[16] = 2
              renderer.configurePaint(paintUniform, n, p); paintUniform.set([field.rect.x, field.rect.y], 204)
              driver.pass(oldSource, paintUniform, [mask, image.texture, mask, field.texture])
              const merge = parameters(destination, r, destination, clip?.rect); merge.set([3, 0, 1, clip ? 1 : 0], 16)
              driver.pass(reference, merge, clip ? [oldSource, empty, mask] : [oldSource, empty])
              const target = renderer.empty(destination)
              candidateMode3 = 0; candidatePaint = undefined; sourceCertificate = false; observing = true
              let output: any
              try { output = await renderer.paintOver(n, p, coverage, target, clip, true) }
              finally { observing = false }
              const bypassed = candidateMode3 === 0 && output.texture === candidatePaint && output.imageZeroOverIdentity === true
              const expected = !name.startsWith('decline-')
              if (bypassed !== expected || candidateMode3 !== (expected ? 0 : 1)) throw Error(`Actual identity path did not match ${name}`)
              const a = await driver.readSurface(reference), b = await driver.readSurface(output.texture)
              const aw = new Uint32Array(a.buffer), bw = new Uint32Array(b.buffer)
              let different = 0, zeroAlphaPixels = 0
              for (let i = 0; i < aw.length; i++) { if (aw[i] !== bw[i]) different++; if (i % 4 === 3 && a[i] === 0) zeroAlphaPixels++ }
              if (['contain-invalid', 'opaque-binary-holes'].includes(name) && !zeroAlphaPixels) throw Error('Zero-alpha boundary control did not run')
              const record = { name, sample, components: aw.length, rawDifferences: different, zeroAlphaPixels, bypassed, sourceCertificate,
                candidateMode3, referenceSha256: await digest(a), candidateSha256: await digest(b) }
              records.push(record); await (globalThis as any).imageIdentityProgress(record)
              if (different) throw Error(`Image identity changed raw f32 words for ${name}/${sample}: ${different}`)
              rawComponents += aw.length; bypasses += Number(bypassed)
              peakTextureBytes = Math.max(peakTextureBytes, driver.stats().textureBytes)
              renderer.release(output); driver.destroy(oldSource); driver.destroy(empty); driver.destroy(reference); driver.destroy(mask)
            }
            // Earlier readSurface boundaries cover every image/field/color
            // reference. present=false/readback=false records no source read.
            const remaining = [...(driver as any).textures].find((texture: Texture) => !permanent.has(texture))
            await driver.finish(remaining!, r, r.w, r.h, false, undefined, false)
            safe = true
          } catch (error) {
            await driver.abortFrameAndReleaseFilterScratch('cancel'); safe = true; throw error
          } finally {
            driver.pass = oldPass
            if (safe) for (const texture of [...(driver as any).textures] as Texture[]) if (!permanent.has(texture)) driver.destroy(texture)
          }
        }
        return { gpuExecuted: true, adapter: driver.stats().adapter, fixtures: payload.names.length, samples: records.length,
          rawComponents, bypasses, peakTextureBytes, records, scope: payload.manifest.scope }
      } finally { driver.dispose(); engine.free() }
    }, { scene, document, node, names, manifest })
  })
})
