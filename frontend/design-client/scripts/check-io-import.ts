// Real DOM parsing, browser SVG reference, and the local CPU WASM renderer.
// Default is CPU only; --gpu additionally checks real production workers on both GPU backends.
// No application UI, Figma writes, storage mocks or shared ports.
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const entryHash = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(client, '../..')
const gpuEnabled = process.argv.includes('--gpu')
const output = process.env.DESIGN_IO_OUTPUT || await mkdtemp(path.join(tmpdir(), 'forma-io-import-'))
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw Error('Refusing nonempty evidence output')
const snapshotRoot = await mkdtemp(path.join(tmpdir(), 'forma-io-import-source-'))
const snapshot = path.join(snapshotRoot, 'frontend/design-client')
await mkdir(snapshot, { recursive: true })
await cp(path.join(core, 'design-studio/crates/design-kernel/shaders'), path.join(snapshotRoot, 'design-studio/crates/design-kernel/shaders'), { recursive: true })
await cp(path.join(client, 'src'), path.join(snapshot, 'src'), { recursive: true })
for (const relative of ['kernel/design_kernel_bg.wasm', 'fonts/NotoSansSC.ttf']) {
  await mkdir(path.dirname(path.join(snapshot, 'public', relative)), { recursive: true })
  await cp(path.join(client, 'public', relative), path.join(snapshot, 'public', relative))
}
await symlink(path.join(client, 'node_modules'), path.join(snapshot, 'node_modules'), 'dir')
const baseline = execFileSync('git', ['show', 'HEAD:frontend/design-client/src/import-svg.ts'], { cwd: core, encoding: 'utf8' })
const baselineModule = new Bun.Transpiler({ loader: 'ts', target: 'browser' })
  .transformSync(baseline.replaceAll("from './", "from '/src/"))
const server = await createServer({ configFile: false, root: snapshot,
  server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { allow: [await realpath(snapshotRoot), await realpath(path.join(core, 'frontend/node_modules'))] } },
  plugins: [{ name: 'isolated-io-page',
    resolveId(id) { if (id === 'virtual:io-baseline') return '\0io-baseline.ts' },
    load(id) { if (id === '\0io-baseline.ts') return baselineModule },
    configureServer(instance) {
      instance.middlewares.use('/__io-check', (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>CPU import audit</body></html>')
      })
    },
  }],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const errors: string[] = []
try {
  await server.listen()
  const base = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    executablePath: process.env.DESIGN_CHROMIUM_EXECUTABLE,
    args: gpuEnabled ? (process.platform === 'darwin' ? ['--use-angle=metal'] : []) : ['--disable-gpu', '--disable-software-rasterizer'],
  })
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`${base}__io-check`)
  const imageFixtures = await Promise.all([
    ['orientation-6.jpg', 'image/jpeg'], ['display-p3-mid-icc.png', 'image/png'], ['lossless.webp', 'image/webp'],
  ].map(async ([name, type]) => ({ name, type, data: (await readFile(path.join(core, 'testing/fixtures/design/io', name))).toString('base64') })))
  const result = await page.evaluate(async ({ imageFixtures, gpuEnabled }) => {
    const { importSvg } = await import('/src/import-svg.ts')
    const { importSvg: importBefore } = await import('/@id/__x00__io-baseline.ts')
    const { initializePicking, prepareDocumentForEditing } = await import('/src/kernel/picking.ts')
    const { VectorEngine, encode_png_rgba } = await import('/src/generated/design-kernel/design_kernel.js')
    await initializePicking()
    const svg = (content: string, attributes = '', width = 32, height = 16) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ${attributes}>${content}</svg>`
    const reference = async (source: string, width: number, height: number) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
      try {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0, width, height)
        return { rgba: context.getImageData(0, 0, width, height).data,
          png: canvas.toDataURL('image/png').split(',')[1] }
      } finally { URL.revokeObjectURL(url) }
    }
    const b64 = (bytes: Uint8Array) => {
      let result = ''; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768))
      return btoa(result)
    }
    const defs = '<defs><rect id="r" width="16" height="16" fill="#ff0000"/></defs>'
    const cases = [
      { id: 'use-opacity', source: svg(`${defs}<use href="#r" opacity=".25"/>`) },
      { id: 'use-hidden', source: svg(`${defs}<use href="#r" display="none"/>`) },
      { id: 'use-clip', source: svg('<defs><rect id="r" width="16" height="16" fill="#ff0000"/><clipPath id="c"><rect width="4" height="16"/></clipPath></defs><use href="#r" clip-path="url(#c)"/>') },
      { id: 'use-inline-clip-opacity', source: svg('<defs><rect id="r" width="16" height="16" fill="#ff0000"/><clipPath id="c"><rect width="4" height="16"/></clipPath></defs><use href="#r" style="clip-path:url(#c);opacity:.5"/>') },
      { id: 'clip-definition-transform', width: 40, height: 20, source: svg('<defs><clipPath id="c" transform="translate(5 0)"><rect width="10" height="20"/></clipPath></defs><rect width="20" height="20" fill="#ff0000" clip-path="url(#c)"/>', '', 40, 20) },
      { id: 'use-bbox-clip', width: 40, height: 20, rejectedMatch: '容器的 objectBoundingBox', source: svg('<defs><rect id="r" width="20" height="20" fill="#ff0000"/><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath></defs><use href="#r" x="10" clip-path="url(#c)"/>', '', 40, 20) },
      { id: 'group-bbox-clip', width: 40, height: 20, rejectedMatch: '容器的 objectBoundingBox', source: svg('<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath></defs><g clip-path="url(#c)"><rect width="20" height="20" fill="#ff0000"/></g>', '', 40, 20) },
      { id: 'group-bbox-mask', width: 40, height: 20, rejectedMatch: '容器的 objectBoundingBox', source: svg('<defs><mask id="c" maskContentUnits="objectBoundingBox"><rect width=".5" height="1" fill="#ffffff"/></mask></defs><g mask="url(#c)"><rect width="20" height="20" fill="#ff0000"/></g>', '', 40, 20) },
      { id: 'viewport-min-meet', width: 200, height: 100, source: svg('<rect width="10" height="10" fill="#ff0000"/>', 'viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet"', 200, 100) },
      { id: 'viewport-max-meet', width: 100, height: 200, source: svg('<rect width="10" height="10" fill="#ff0000"/>', 'viewBox="0 0 100 100" preserveAspectRatio="xMaxYMax meet"', 100, 200) },
      { id: 'viewport-slice', width: 200, height: 100, source: svg('<rect width="100" height="100" fill="#ff0000"/><rect width="100" height="25" fill="#0000ff"/>', 'viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"', 200, 100) },
      { id: 'viewport-none', width: 200, height: 100, source: svg('<rect width="10" height="10" fill="#ff0000"/>', 'viewBox="0 0 100 100" preserveAspectRatio="none"', 200, 100) },
    ]
    const rows = []
    for (const control of cases) {
      const width = control.width || 32, height = control.height || 16
      const expected = await reference(control.source, width, height)
      const variants = []
      for (const [name, importer] of [['baseline', importBefore], ['current', importSvg]] as const) {
        const engine = new VectorEngine()
        try {
          const imported = importer(control.source, control.id)
          const doc = prepareDocumentForEditing(imported.document)
          engine.load_document(JSON.stringify(doc))
          const rgba = engine.render_rgba(JSON.stringify({ pageId: doc.pages[0].id, width, height,
            view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' }))
          let differentPixels = 0, max = 0
          for (let i = 0; i < rgba.length; i += 4) {
            let differs = false
            for (let c = 0; c < 4; c++) { const d = Math.abs(rgba[i + c] - expected.rgba[i + c]); max = Math.max(max, d); differs ||= d !== 0 }
            differentPixels += Number(differs)
          }
          variants.push({ name, differentPixels, max, warnings: imported.warnings,
            png: b64(encode_png_rgba(width, height, rgba)) })
        } catch (error) { variants.push({ name, error: String(error) }) }
        finally { engine.free() }
      }
      rows.push({ ...control, width, height, referencePng: expected.png, variants })
    }
    const unsupported = [
      { id: 'nested-svg', source: svg('<svg x="8" y="4" width="8" height="8" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>'), match: '嵌套' },
      { id: 'elliptical-radius', source: svg('<rect width="20" height="12" rx="8" ry="2"/>'), match: '椭圆圆角' },
      { id: 'gradient-repeat', source: svg('<defs><linearGradient id="g" spreadMethod="repeat"><stop stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect width="20" height="12" fill="url(#g)"/>'), match: '重复或镜像' },
    ].map((control) => {
      let currentError = '', baselineError = ''
      try { importSvg(control.source) } catch (error) { currentError = String(error) }
      try { importBefore(control.source) } catch (error) { baselineError = String(error) }
      return { ...control, currentError, baselineError, rejectedExplicitly: currentError.includes(control.match) }
    })
    const { imageData } = await import('/src/persistence.ts')
    const { blank, node, paint } = await import('/src/model.ts')
    const images = [], gpuCases = []
    const diff = (a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) return { differentPixels: -1, max: 256, lengths: [a.length, b.length] }
      let differentPixels = 0, max = 0
      for (let i = 0; i < a.length; i += 4) {
        let changed = false
        for (let c = 0; c < 4; c++) { const d = Math.abs(a[i + c] - b[i + c]); max = Math.max(max, d); changed ||= d !== 0 }
        differentPixels += Number(changed)
      }
      return { differentPixels, max }
    }
    for (const fixture of imageFixtures) {
      const input = Uint8Array.from(atob(fixture.data), (c) => c.charCodeAt(0))
      const imported = await imageData(new File([input], fixture.name, { type: fixture.type }))
      const expectedImage = new Image(); expectedImage.src = imported.data; await expectedImage.decode()
      const canvas = document.createElement('canvas'); canvas.width = imported.width; canvas.height = imported.height
      const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
      context.drawImage(expectedImage, 0, 0)
      const expected = context.getImageData(0, 0, canvas.width, canvas.height).data
      const doc = blank(fixture.name), shape = node('rectangle', 0, 0, imported.width, imported.height)
      shape.fills = [{ ...paint('#ffffff', 'image'), image: imported.data, fit: 'stretch' }]
      doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
      const engine = new VectorEngine()
      try {
        engine.load_document(JSON.stringify(doc))
        const info = JSON.parse(engine.image_info(imported.data))
        const rgba = engine.render_rgba(JSON.stringify({ pageId: doc.pages[0].id, width: imported.width, height: imported.height,
          view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' }))
        let differentPixels = 0, max = 0
        for (let i = 0; i < rgba.length; i += 4) {
          let differs = false
          for (let c = 0; c < 4; c++) { const d = Math.abs(rgba[i + c] - expected[i + c]); max = Math.max(max, d); differs ||= d !== 0 }
          differentPixels += Number(differs)
        }
        images.push({ name: fixture.name, browserSize: [imported.width, imported.height], kernelInfo: info,
          originalBytesPreserved: imported.data === `data:${fixture.type};base64,${fixture.data}`,
          differentPixels, max, referenceFirstPixel: Array.from(expected.slice(0, 4)), kernelFirstPixel: Array.from(rgba.slice(0, 4)),
          referencePng: canvas.toDataURL('image/png').split(',')[1], kernelPng: b64(encode_png_rgba(imported.width, imported.height, rgba)) })
      } catch (error) { images.push({ name: fixture.name, error: String(error) }) }
      finally { engine.free() }
      if (gpuEnabled) {
        const { KernelClient } = await import('/src/kernel/client.ts')
        // A fractional placement/scale exercises actual texture decoding and
        // interpolation, not only a solid 1:1 upload. CPU reference uses the
        // requested profile; browser PNG differences above stay independent.
        const placed = structuredClone(doc)
        Object.assign(placed.nodes[shape.id], { width: imported.width * 3 + .5, height: imported.height * 3 + .5,
          transform: [1, 0, 0, 1, 3.25, 2.5] })
        for (const rasterProfile of ['analytic', 'figma', 'figmaSubpixel', 'figmaSoftware'] as const) {
          const width = 48, height = 48
          const options = { pageId: placed.pages[0].id, width, height, view: { x: .125, y: .25, zoom: 1 },
            transparent: true, grid: false, rasterProfile }
          const cpu = new VectorEngine()
          let expected: Uint8Array
          try { cpu.load_document(JSON.stringify(placed)); expected = cpu.render_rgba(JSON.stringify(options)) }
          finally { cpu.free() }
          for (const backend of ['webgpu', 'webgl2'] as const) {
            const worker = new KernelClient()
            try {
              const full = await worker.render(placed, options, false, backend, true)
              full.bitmap?.close()
              const received: any[] = [], tiled = new Uint8Array(width * height * 4)
              const plan = [0, 24].map(x => ({ key: `${fixture.name}/${rasterProfile}/${backend}/${x}`, x, y: 0,
                width: 24, height, zoom: 1, phaseX: .125, phaseY: .25 }))
              const completed = await worker.render(placed, { ...options,
                tileOwner: { documentId: placed.id, sessionEpoch: 1 }, tileViewport: plan }, false, backend, true, false,
                { disableExactTileCache: true }, tile => {
                  if (tile.bytes.length !== tile.width * tile.height * 4) throw Error('Unexpected tile byte length')
                  for (let y = 0; y < tile.height; y++) tiled.set(tile.bytes.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
                    ((tile.y + y) * width + tile.x) * 4)
                  received.push({ x: tile.x, y: tile.y, width: tile.width, height: tile.height, backend: tile.backend,
                    cached: tile.cached, description: tile.description })
                })
              completed.bitmap?.close()
              const row = { name: fixture.name, rasterProfile, requestedBackend: backend, actualBackend: full.backend,
                description: full.description, drawCalls: full.drawCalls, width, height,
                full: diff(full.bytes, expected!), tiled: diff(tiled, expected!), fullVsTiled: diff(full.bytes, tiled),
                completionBackend: completed.backend, tiles: received,
                cpuPng: b64(encode_png_rgba(width, height, expected!)),
                fullPng: b64(encode_png_rgba(width, height, full.bytes)),
                tiledPng: b64(encode_png_rgba(width, height, tiled)) }
              gpuCases.push(row)
            } catch (error) { gpuCases.push({ name: fixture.name, rasterProfile, requestedBackend: backend, error: String(error) }) }
            finally { worker.dispose() }
          }
        }
      }
    }
    const jpeg = imageFixtures.find(f => f.name === 'orientation-6.jpg')!
    const original = Uint8Array.from(atob(jpeg.data), c => c.charCodeAt(0))
    const index = (needle: number[]) => original.findIndex((_, at) => needle.every((v, i) => original[at + i] === v))
    const tiff = index([69,120,105,102,0,0]) + 6, tag = index([1,18,0,3,0,0,0,1,0,6])
    if (tiff < 6 || tag < 0) throw Error('EXIF synthetic fixture precondition changed')
    const malformedExif = []
    for (const name of ['orientation-0', 'orientation-9', 'bad-tiff-magic']) {
      const source = original.slice()
      if (name === 'bad-tiff-magic') source[tiff + 3] = 43
      else source[tag + 9] = name === 'orientation-0' ? 0 : 9
      const engine = new VectorEngine()
      try { malformedExif.push({ name, rejected: false, dimensions: JSON.parse(engine.image_info(`data:image/jpeg;base64,${b64(source)}`)) }) }
      catch (error) { malformedExif.push({ name, rejected: String(error).includes('EXIF'), error: String(error) }) }
      finally { engine.free() }
    }
    return { rows, unsupported, images, malformedExif, gpuCases }
  }, { imageFixtures, gpuEnabled })
  const metadata: any = { browser: await browser.version(), execution: gpuEnabled ? 'Headless Chromium with real production WebGPU/WebGL2 workers; explicit backend required, CPU fallback fails; CPU and browser references separate' : 'headless Chromium with GPU and software rasterizer disabled; actual DOM/SVG Canvas2D reference and CPU WASM only', errors, cases: [], unsupported: result.unsupported }
  for (const row of result.rows) {
    await writeFile(path.join(output, `${row.id}.svg`), row.source)
    await writeFile(path.join(output, `${row.id}-reference.png`), Buffer.from(row.referencePng, 'base64'))
    for (const variant of row.variants) if ('png' in variant)
      await writeFile(path.join(output, `${row.id}-${variant.name}.png`), Buffer.from(variant.png, 'base64'))
    metadata.cases.push({ id: row.id, width: row.width, height: row.height, rejectedMatch: row.rejectedMatch,
      variants: row.variants.map(({ png, ...rest }: any) => rest) })
  }
  metadata.images = []
  for (const row of result.images) {
    if ('referencePng' in row) {
      await writeFile(path.join(output, `${row.name}-reference.png`), Buffer.from(row.referencePng, 'base64'))
      await writeFile(path.join(output, `${row.name}-kernel.png`), Buffer.from(row.kernelPng, 'base64'))
    }
    const { referencePng, kernelPng, ...detail } = row as any
    metadata.images.push(detail)
  }
  metadata.malformedExif = result.malformedExif
  metadata.gpuEnabled = gpuEnabled
  metadata.gpuCases = []
  for (const row of result.gpuCases) {
    const { cpuPng, fullPng, tiledPng, ...detail } = row as any
    const id = `${row.name}-${row.rasterProfile}-${row.requestedBackend}`
    for (const [kind, encoded] of Object.entries({ cpuPng, fullPng, tiledPng }))
      if (encoded) await writeFile(path.join(output, `${id}-${kind}.png`), Buffer.from(encoded as string, 'base64'))
    metadata.gpuCases.push(detail)
  }
  const gpuPassed = !gpuEnabled || result.gpuCases.length === 24 && result.gpuCases.every((row: any) =>
    !row.error && row.actualBackend === row.requestedBackend && row.drawCalls > 0 &&
    row.completionBackend === row.requestedBackend && row.tiles.length === 2 &&
    row.tiles.every((tile: any) => tile.backend === row.requestedBackend && !tile.cached && tile.width === 24 && tile.height === 48) &&
    row.full.differentPixels === 0 && row.tiled.differentPixels === 0 && row.fullVsTiled.differentPixels === 0)
  metadata.status = errors.length === 0 && gpuPassed && result.malformedExif.every(v => v.rejected) && result.rows.every((row) => {
    const current = row.variants.find((v) => v.name === 'current')
    return current && (row.rejectedMatch ? 'error' in current && current.error.includes(row.rejectedMatch) : !('error' in current) && current.differentPixels === 0)
  }) && result.unsupported.every((v) => v.rejectedExplicitly) && result.images.every((v) => !('error' in v) && v.originalBytesPreserved && v.differentPixels === 0 && v.kernelInfo[0] === v.browserSize[0] && v.kernelInfo[1] === v.browserSize[1]) ? 'passed' : 'failed'
  metadata.sourceHashes = {}
  for (const file of ['src/import-svg.ts', 'src/import-svg-viewport.ts', 'public/kernel/design_kernel_bg.wasm'])
    metadata.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(snapshot, file))).digest('hex')
  async function hashTree(dir: string, label: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), key = `${label}/${entry.name}`
      if (entry.isDirectory()) await hashTree(file, key)
      else metadata.sourceHashes[key] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
  await hashTree(path.join(snapshot, 'src'), 'src')
  await hashTree(path.join(snapshotRoot, 'design-studio/crates/design-kernel/shaders'), 'shaders')
  metadata.sourceHashes['scripts/check-io-import.ts'] = entryHash
  metadata.baselineSourceSha256 = createHash('sha256').update(baseline).digest('hex')
  await writeFile(path.join(output, 'results.json'), JSON.stringify(metadata, null, 2))
  console.log(JSON.stringify({ output, status: metadata.status, images: metadata.images, malformedExif: metadata.malformedExif, gpuCases: metadata.gpuCases, cases: metadata.cases, unsupported: metadata.unsupported.map(({ id, rejectedExplicitly }: any) => ({ id, rejectedExplicitly })) }, null, 2))
  if (metadata.status !== 'passed') process.exitCode = 1
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ status: 'harness-failed', error: String(error), snapshot }, null, 2))
  throw error
} finally { await browser?.close(); await server.close() }
