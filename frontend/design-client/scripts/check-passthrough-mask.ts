/** Real GPU regression for coverage-free groups and the boundaries that need coverage. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-passthrough-mask-'))
await mkdir(output, { recursive: true })
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20000)
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Vite exited ${code}`)) })
    server.stdout.on('data', value => { const match = String(value).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage()
  await page.goto(`${base}/gpu-check.html`)
  const rows = await page.evaluate(async () => {
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { initializePicking } = await import('/src/kernel/picking.ts')
    const { blank, node, paint, stroke, effect } = await import('/src/model.ts')
    const { defaultColorSettings } = await import('/src/color.ts')
    await initializePicking()
    const rows = [], client = new KernelClient()
    try {
      for (const variant of ['pure', 'clip', 'opacity', 'multiply', 'effect', 'glass', 'glass-clip', 'glass-opacity', 'glass-blur', 'glass-leaf', 'glass-leaf-clip', 'glass-leaf-stroke', 'glass-leaf-blur', 'shadow', 'inner-shadow', 'blur-shadow', 'blur-inner-shadow', 'shadow-spread', 'mask-alpha', 'mask-luminance']) {
        const doc = blank(`Coverage-free group: ${variant}`), background = node('rectangle', 0, 0, 80, 64)
        const group = node(variant.startsWith('glass') ? 'frame' : 'group', 20, 16, 24, 24), a = node('ellipse', -9, -7, 42, 37), b = node('rectangle', 8, 7, 27, 22)
        doc.schemaVersion = 5; doc.colorManagement = defaultColorSettings(); doc.rasterProfile = 'figma'
        background.fills = [paint('color(srgb-linear 0.2 0.4 0.8)')]
        group.blend = variant === 'multiply' ? 'multiply' : variant.startsWith('glass') ? 'normal' : 'pass-through'
        group.fills = []; group.clip = variant.endsWith('clip'); group.opacity = variant.endsWith('opacity') ? 0.5 : 1
        if (variant === 'effect') group.effects = [effect('noise')]
        if (variant.includes('shadow')) {
          const shadow = { ...effect(variant.includes('inner') ? 'inner-shadow' : 'shadow'), radius: 2,
            spread: variant === 'shadow-spread' ? 2 : 0, x: 1.375, y: -0.625 }
          group.effects = variant.startsWith('blur-') ? [{ ...effect('blur'), radius: 1 }, shadow] : [shadow]
        }
        if (variant.startsWith('glass')) group.effects = [{ ...effect('glass'), radius: 1 }]
        if (variant.endsWith('blur')) group.effects.push({ ...effect('blur'), radius: 1 })
        a.fills = [{ ...paint('color(srgb-linear 1.5 0.15 0.3)'), opacity: 0.7 }]
        b.fills = [{ ...paint('color(srgb-linear 0.15 1.4 0.5)'), opacity: 0.6 }]
        group.children = [a.id, b.id]
        if (variant.startsWith('mask-')) { a.mask = true; a.maskType = variant === 'mask-alpha' ? 'alpha' : 'luminance' }
        doc.nodes = { [background.id]: background, [group.id]: group, [a.id]: a, [b.id]: b }
        doc.pages[0].children = [background.id, group.id]
        if (variant.includes('leaf')) {
          group.children = []; delete doc.nodes[a.id]; delete doc.nodes[b.id]
          group.fills = [{ ...paint('color(srgb-linear 1.2 0.2 0.5)'), opacity: 0.2 }]
          if (variant.endsWith('stroke')) group.strokes = [{ ...stroke('#ffd080', 3), align: 'inside' }]
          if (variant.endsWith('clip')) {
            const boundary = node('frame', 0, 0, 31, 35)
            boundary.fills = []; boundary.clip = true; boundary.children = [group.id]
            doc.nodes[boundary.id] = boundary; doc.pages[0].children = [background.id, boundary.id]
          }
        }
        const options = { pageId: doc.pages[0].id, width: 80, height: 64, view: { x: 0.375, y: 0.625, zoom: 1 }, transparent: false, grid: false, rasterProfile: 'figma' as const }
        const cpu = await client.render(doc, options, false, 'cpu', true)
        try {
          for (const backend of ['webgpu', 'webgl2'] as const) for (const reference of [false, true]) {
            try {
              const result = await client.render(doc, options, false, backend, true, reference)
              if (result.backend !== backend || !result.linear || !cpu.linear) throw Error('Requested HDR backend was not preserved')
              if (result.bytes.length !== cpu.bytes.length || result.linear.length !== cpu.linear.length) throw Error('Pixel dimensions differ')
              const bits = new Uint32Array(result.linear.buffer, result.linear.byteOffset, result.linear.length)
              const expected = new Uint32Array(cpu.linear.buffer, cpu.linear.byteOffset, cpu.linear.length)
              rows.push({ variant, backend, reference, byteDifferences: result.bytes.reduce((n, value, i) => n + Number(value !== cpu.bytes[i]), 0),
                bitDifferences: bits.reduce((n, value, i) => n + Number(value !== expected[i]), 0), milliseconds: result.milliseconds })
              result.bitmap?.close()
            } catch (error) { rows.push({ variant, backend, reference, error: String(error) }) }
          }
        } finally { cpu.bitmap?.close() }
      }
    } finally { client.dispose() }
    return rows
  })
  await writeFile(join(output, 'results.json'), JSON.stringify(rows, null, 2))
  const failures = rows.filter(row => row.error || row.byteDifferences || row.bitDifferences)
  console.log(JSON.stringify({ output, checks: rows.length, failures }))
  if (failures.length) throw Error('Pass-through group exact GPU regression failed')
} finally { await browser?.close(); server.kill('SIGTERM') }
