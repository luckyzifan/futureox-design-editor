import { expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Editor } from '../../design-client/src/engine'
import { blank, paint } from '../../design-client/src/model'
import { createEditorDesignAutomation } from '../../design-client/src/automation'
import { OperationBackend } from '../src/operation-backend.mjs'
import { DesignMcpServer } from '../src/server.mjs'

type Json = Record<string, any>
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
it('generates original readable login/dashboard examples through real MCP operations', async () => {
  const destination = process.env.FUTUREOX_MCP_EXAMPLE_DIR
  if (!destination || !path.isAbsolute(destination)) throw new Error('Set FUTUREOX_MCP_EXAMPLE_DIR to an absolute output directory')
  const started = performance.now(), document = blank('Luma Workspace / API-authored example'), editor = new Editor(document)
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request) })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let buffer = '', sequence = 0, nextNode = 0
  const pending = new Map<number, (response: Json) => void>(), transcript: Json[] = []
  output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const resolve = pending.get(response.id); pending.delete(response.id); resolve?.(response) } })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${id} ${method} timed out; phase=${server.phase}, pending=${server.requests.size}, output=${server.queuedBytes}`)) }, 60000); server.done.then(() => { if (pending.delete(id)) { clearTimeout(timer); reject(new Error('MCP connection closed before the response')) } }); pending.set(id, response => { clearTimeout(timer); resolve(response) }); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n') })
  const call = async (method: string, params: Json = {}, writes = false) => {
    let fence: Json = {}
    if (writes) {
      const current = await call('document.get')
      fence = { documentId: current.documentId, session: current.session, expectedRevision: current.revision }
    }
    const start = performance.now()
    const response = await rpc('tools/call', { name: `design_${method.replaceAll('.', '_')}`, arguments: { params, ...fence } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    const result = response.result.structuredContent
    transcript.push({ method, toolResponseBytes: Buffer.byteLength(JSON.stringify(response)), ok: result.ok, revision: result.revision, elapsedMs: Math.round(performance.now() - start), ...(method === 'batch.apply' ? { operations: params.operations.length } : {}) })
    expect(response.result.isError, result.ok ? undefined : JSON.stringify(result.error)).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(256 * 1024)
    // This packager explicitly reads resources to save files, not to feed binary to a model.
    const restored = { ...result.result }
    for (const ref of restored.resources ?? []) {
      const file = await rpc('resources/read', { uri: ref.uri })
      expect(file.error).toBeUndefined()
      const content = file.result.contents[0]
      const data = ref.encoding === 'json' ? JSON.parse(content.text) : ref.encoding === 'base64' ? content.blob : ref.encoding === 'data-url' ? `data:${ref.mimeType};base64,${content.blob}` : content.text
      if (ref.field === '$metadata') Object.assign(restored, data)
      else restored[ref.field] = data
    }
    return { ...result, result: restored }
  }
  const uid = () => `20000000-0000-4000-8000-${String(++nextNode).padStart(12, '0')}`
  const operations: Json[] = []
  const shape = (parentId: string, name: string, x: number, y: number, width: number, height: number, color: string, radius = 0, kind = 'frame') => {
    const id = uid()
    operations.push({ method: 'node.create', params: { id, kind, parentId, x, y, width, height, patch: { name, fills: [paint(color)], radii: [radius, radius, radius, radius] } } })
    return id
  }
  const text = (parentId: string, value: string, x: number, y: number, width: number, height: number, size = 20, color = '#182334', weight = 400) => {
    const id = uid()
    operations.push({ method: 'node.create', params: { id, kind: 'text', parentId, x, y, width, height, patch: { name: value.replaceAll('\n', ' ').slice(0, 80), fills: [paint(color)] } } })
    operations.push({ method: 'text.set', params: { ids: [id], text: value, fontSize: size, textStyle: { fontId: 'luma-noto', weight, lineHeight: 1.25, wrap: true } } })
    return id
  }
  try {
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'futureox-original-example', version: '1' } })
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const font = await readFile(new URL('../../design-client/public/fonts/NotoSansSC.ttf', import.meta.url))
    await call('font.import', { id: 'luma-noto', data: font.toString('base64'), embeddingAllowed: true }, true)
    expect((await call('font.validate')).result.valid).toBe(true)
    const loginPage = editor.state.page, dashboardPage = '30000000-0000-4000-8000-000000000002'
    const login = shape(loginPage, 'Login / Desktop 1440×960', 0, 0, 1440, 960, '#f5f3ee')
    const hero = shape(login, 'Brand panel', 0, 0, 650, 960, '#182334')
    const logo = shape(hero, 'Luma original mark', 64, 62, 36, 36, '#b4efd8', 12)
    text(hero, 'Luma Workspace', 116, 63, 400, 40, 24, '#ffffff', 600)
    text(hero, 'A clear view of\nwhat matters.', 64, 246, 540, 210, 64, '#ffffff', 700)
    text(hero, 'Bring your projects, people, and next steps\ninto one thoughtfully organized place.', 68, 490, 520, 80, 23, '#c3cbd5')
    for (let i = 0; i < 5; i++) shape(hero, `Original rising bar ${i + 1}`, 72 + i * 102, 790 - i * 32, 76, 84 + i * 32, i % 2 ? '#789e95' : '#b4efd8', 14)
    text(hero, 'Made for calmer, more focused work.', 68, 896, 540, 30, 17, '#c3cbd5')
    const card = shape(login, 'Sign in form', 760, 174, 572, 610, '#ffffff', 24)
    text(card, 'Welcome back', 44, 42, 480, 60, 40, '#182334', 700)
    text(card, 'Sign in to your workspace to keep things moving.', 46, 111, 480, 52, 19, '#738091')
    text(card, 'Email address', 46, 187, 480, 32, 18, '#182334', 600)
    const email = shape(card, 'Email field', 44, 229, 480, 64, '#f3f5f8', 10)
    text(email, 'you@company.com', 18, 18, 440, 30, 18, '#8c96a5')
    text(card, 'Password', 46, 320, 480, 32, 18, '#182334', 600)
    const password = shape(card, 'Password field', 44, 362, 480, 64, '#f3f5f8', 10)
    text(password, 'Enter your password', 18, 18, 440, 30, 18, '#8c96a5')
    const button = shape(card, 'Primary submit button', 44, 464, 480, 64, '#4469e8', 10)
    const buttonLabel = text(button, 'Continue to workspace', 106, 18, 350, 32, 20, '#ffffff', 600)
    text(card, 'New here? Create an account', 108, 554, 400, 30, 17, '#4469e8')
    text(login, 'Privacy  ·  Terms  ·  Help', 924, 866, 400, 30, 16, '#738091')
    operations.push({ method: 'page.create', params: { id: dashboardPage, name: 'Dashboard', makeCurrent: false } })
    const dashboard = shape(dashboardPage, 'Dashboard / Desktop 1440×960', 0, 0, 1440, 960, '#f5f7fb')
    const sidebar = shape(dashboard, 'Sidebar', 0, 0, 236, 960, '#ffffff')
    shape(sidebar, 'Brand mark', 26, 36, 30, 30, '#4469e8', 10)
    text(sidebar, 'Luma', 70, 34, 130, 40, 28, '#182334', 700)
    shape(sidebar, 'Overview active state', 18, 135, 198, 52, '#edf1ff', 10)
    for (const [i, label] of ['Overview', 'Projects', 'Team', 'Reports', 'Settings'].entries()) text(sidebar, label, 42, 149 + i * 66, 172, 32, 19, i === 0 ? '#4469e8' : '#738091', i === 0 ? 600 : 400)
    text(sidebar, 'WORKSPACE', 28, 823, 180, 24, 13, '#8c96a5', 600)
    text(sidebar, 'Acme Studio', 28, 861, 180, 32, 20, '#182334', 600)
    text(dashboard, 'Overview', 278, 50, 700, 60, 38, '#182334', 700)
    text(dashboard, 'A snapshot of your team’s progress this week.', 280, 112, 1000, 40, 19, '#738091')
    const stats = shape(dashboard, 'Weekly metrics', 278, 184, 1116, 146, '#f5f7fb')
    operations.push({ method: 'layout.set', params: { ids: [stats], layout: { mode: 'horizontal', gap: 24, padding: [0, 0, 0, 0] } } })
    for (const [i, metric] of [['Active projects', '12', '+2 this week'], ['Completed tasks', '148', '+18% this week'], ['Team utilization', '84%', 'On track']].entries()) {
      const tile = shape(stats, `Metric ${metric[0]}`, i * 380, 0, 356, 146, '#ffffff', 16)
      text(tile, metric[0], 24, 20, 310, 32, 17, '#738091')
      text(tile, metric[1], 24, 58, 170, 58, 40, '#182334', 700)
      text(tile, metric[2], 188, 93, 150, 25, 14, '#3d9874')
    }
    const chart = shape(dashboard, 'Weekly activity card', 278, 356, 720, 270, '#ffffff', 16)
    text(chart, 'Weekly activity', 26, 20, 500, 40, 22, '#182334', 600)
    for (const [i, height] of [72, 120, 96, 142, 108, 160, 132].entries()) {
      shape(chart, `Activity bar ${i + 1}`, 48 + i * 92, 224 - height, 50, height, i === 5 ? '#4469e8' : '#b6c6f9', 6)
      text(chart, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i], 45 + i * 92, 232, 68, 24, 14, '#738091')
    }
    const focus = shape(dashboard, 'Focus card', 1022, 356, 372, 270, '#182334', 16)
    text(focus, 'Today’s focus', 26, 26, 320, 40, 23, '#ffffff', 600)
    text(focus, 'Brand refresh', 28, 88, 320, 36, 24, '#ffffff', 600)
    text(focus, 'Review the new visual direction\nwith your design team.', 28, 138, 320, 74, 17, '#c3cbd5')
    text(focus, 'View project →', 28, 220, 300, 30, 17, '#b4efd8', 600)
    const table = shape(dashboard, 'Recent projects card', 278, 650, 1116, 260, '#ffffff', 16)
    text(table, 'Recent projects', 26, 18, 600, 40, 22, '#182334', 600)
    text(table, 'PROJECT', 28, 72, 500, 24, 13, '#8c96a5', 600)
    text(table, 'OWNER', 500, 72, 240, 24, 13, '#8c96a5', 600)
    text(table, 'STATUS', 820, 72, 240, 24, 13, '#8c96a5', 600)
    for (const [i, row] of [['Brand refresh', 'Design team', 'In progress'], ['Website launch', 'Web team', 'In review'], ['Customer insights', 'Research team', 'Completed']].entries()) {
      shape(table, `Row divider ${i}`, 26, 108 + i * 48, 1060, 1, '#edf0f5', 0, 'rectangle')
      text(table, row[0], 28, 120 + i * 48, 460, 28, 17, '#182334', 500)
      text(table, row[1], 500, 120 + i * 48, 280, 28, 17, '#738091')
      text(table, row[2], 820, 120 + i * 48, 230, 28, 16, i === 2 ? '#3d9874' : '#4469e8', 500)
    }
    expect(operations.length).toBeLessThan(500)
    await call('batch.apply', { operations, label: 'Create original login and dashboard' }, true)
    await call('text.set', { ids: [buttonLabel], text: 'Sign in to workspace' }, true)
    await mkdir(path.join(destination, 'fonts'), { recursive: true })
    await writeFile(path.join(destination, 'fonts', 'NotoSansSC.ttf'), Buffer.from(editor.state.doc.fonts!['luma-noto'].data, 'base64'))
    await copyFile(new URL('../../design-client/public/fonts/OFL.txt', import.meta.url), path.join(destination, 'fonts', 'OFL.txt'))
    await copyFile(new URL('../../design-client/public/fonts/source.json', import.meta.url), path.join(destination, 'fonts', 'source.json'))
    const outputs: Json[] = [], checks: Json[] = []
    for (const [name, pageId, root] of [['login', loginPage, login], ['dashboard', dashboardPage, dashboard]]) {
      const directory = path.join(destination, name); await mkdir(directory, { recursive: true })
      const context = await call('context.get', { pageId, nodeIds: [root], limit: 500 })
      const check = await call('design.check', { pageId, nodeIds: [root], limit: 500 }); checks.push({ name, ...check.result })
      const code = (await call('code.export', { pageId, nodeIds: [root], maxNodes: 500 })).result
      const svg = (await call('vector.export', { pageId, nodeIds: [root], maxNodes: 500 })).result
      await writeFile(path.join(directory, 'raw-api.html'), code.html)
      await writeFile(path.join(directory, 'export.html'), code.html.replace('href="styles.css"', 'href="export.css"'))
      await writeFile(path.join(directory, 'export.css'), code.css)
      const family = JSON.stringify(editor.state.doc.fonts!['luma-noto'].family)
      const fontCss = `/* Sample packaging glue; code.export does not export native font binaries. */\n@font-face{font-family:${family};src:url("../fonts/NotoSansSC.ttf") format("truetype");font-weight:100 900;font-style:normal;font-display:swap}\n`
      const packagedHtml = code.html.replace("style-src 'self';", "style-src 'self'; font-src 'self';")
      await writeFile(path.join(directory, 'index.html'), packagedHtml)
      await writeFile(path.join(directory, 'styles.css'), fontCss + code.css)
      await writeFile(path.join(directory, 'design.svg'), svg.content)
      await writeFile(path.join(directory, 'context.json'), JSON.stringify(context.result, null, 2))
      await writeFile(path.join(directory, 'export-manifest.json'), JSON.stringify({ ...code, html: undefined, css: undefined }, null, 2))
      const fontEntries = [{ id: 'luma-noto', path: '../fonts/NotoSansSC.ttf', source: 'Actual embedded native font, extracted by example packager', bytes: font.length }]
      outputs.push({ name, pageId, rootId: root, htmlSha256: hash(code.html), cssSha256: hash(code.css), svgSha256: hash(svg.content), warnings: code.warnings, packagedFonts: fontEntries.length, fontPackagingGlue: true, nodeCount: context.result.nodes.length })
    }
    const fd = (await call('document.export', { format: 'fd' })).result
    const native = (await call('document.export')).result
    await writeFile(path.join(destination, 'luma-workspace.fd'), Buffer.from(fd.base64, 'base64'))
    await writeFile(path.join(destination, 'luma-workspace.json'), native.content)
    const logoSvg = (await call('vector.export', { pageId: loginPage, nodeIds: [logo] })).result.content
    await mkdir(path.join(destination, 'assets'), { recursive: true }); await writeFile(path.join(destination, 'assets', 'luma-mark.svg'), logoSvg)
    await writeFile(path.join(destination, 'checks.json'), JSON.stringify(checks, null, 2))
    await writeFile(path.join(destination, 'operations.json'), JSON.stringify(transcript, null, 2))
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ version: 1, title: 'Luma Workspace', originalSyntheticExample: true, resourceFirstExport: true, mcpToolResponseBytesMax: Math.max(...transcript.map(item => item.toolResponseBytes)), generationPath: 'MCP JSON-RPC -> OperationBackend -> shared API -> real Editor/WASM', documentId: editor.state.doc.id, nodeCount: Object.keys(editor.state.doc.nodes).length, outputs, font: { source: 'Repository bundled NotoSansSC.ttf, unchanged', bytes: font.length, sha256: hash(font), license: 'SIL Open Font License 1.1', licenseFile: 'fonts/OFL.txt' }, nativeFd: { bytes: fd.bytes, sha256: hash(Buffer.from(fd.base64, 'base64')) }, elapsedMs: Math.round(performance.now() - started), gpuRenderingRun: false, visualBrowserAcceptance: 'Not run by this generator', fidelity: 'HTML/CSS is approximate; native document is lossless; SVG uses existing geometry exporter' }, null, 2))
    await writeFile(path.join(destination, 'README.txt'), 'Original synthetic Luma Workspace example created through the actual Futureox MCP operation API.\n\nOpen login/index.html or dashboard/index.html to inspect the exported HTML/CSS. Fonts are the repository’s unchanged Noto Sans SC under SIL OFL 1.1; the license is included in fonts/OFL.txt. Exact API output is retained in each page raw-api.html and export.css. The export.html copy only renames its stylesheet link. The index.html/styles.css versions add sample-only font packaging glue and a self-only font CSP; font binaries/@font-face are not emitted by code.export itself. The exporter may report approximation warnings; see each export-manifest.json and checks.json. Native source is luma-workspace.fd (real binary) or luma-workspace.json. No product renderer was changed or GPU validation claimed. The example does not implement sign-in, networking or live dashboard data.\n')
    expect(outputs.every(out => out.packagedFonts === 1)).toBe(true)
    console.info(JSON.stringify({ example: destination, nodes: Object.keys(editor.state.doc.nodes).length, fontBytes: font.length, elapsedMs: Math.round(performance.now() - started) }))
  } finally { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() }
}, 180000)
