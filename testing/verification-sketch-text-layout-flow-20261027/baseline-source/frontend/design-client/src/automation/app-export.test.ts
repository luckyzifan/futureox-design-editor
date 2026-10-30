import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../engine'
import { paint, uid } from '../model'
import { createEditorDesignAutomation } from './index'
import { exportDesignCode } from './export'
import { exportRunnableApp, type AppExportOptions } from './app-export'
import { runnableAppFixture } from './app-export-fixture'
import { appExportZip, sandboxedAppPreview } from './app-export-artifacts'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'

const { JSDOM, ResourceLoader, VirtualConsole } = createRequire(import.meta.url)('jsdom')
type Bundle = ReturnType<typeof exportRunnableApp>
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
function exportFixture() { const f = runnableAppFixture(); return { ...f, bundle: exportRunnableApp(f.document, { version: 1, app: f.app }) } }

/** Execute the actual emitted app.js and index.html using an in-memory resource
 * loader. No socket, OS browser, GPU, fake runtime handlers or script rewrite. */
async function openApp(bundle: Bundle, options: { stored?: Record<string, string>; denied?: boolean; quota?: boolean; hash?: string } = {}) {
  const requests: string[] = [], errors: Error[] = [], storage = new Map(Object.entries(options.stored ?? {}))
  class OfflineResources extends ResourceLoader {
    fetch(url: string) {
      requests.push(url)
      if (url === 'https://offline.test/styles.css') return Promise.resolve(Buffer.from(bundle.css))
      if (url === 'https://offline.test/app.js') return Promise.resolve(Buffer.from(bundle.javascript))
      throw new Error(`Unexpected network resource: ${url}`)
    }
  }
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error))
  const dom = new JSDOM(bundle.html, {
    url: `https://offline.test/index.html${options.hash ?? ''}`, resources: new OfflineResources(), runScripts: 'dangerously', virtualConsole,
    beforeParse(window: any) {
      Object.defineProperty(window, 'localStorage', { get() {
        if (options.denied) throw new window.DOMException('Storage denied', 'SecurityError')
        return {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => { if (options.quota) throw new window.DOMException('Quota exceeded', 'QuotaExceededError'); storage.set(key, String(value)) },
        }
      } })
    },
  })
  cleanups.push(() => dom.window.close())
  await new Promise<void>(resolve => dom.window.addEventListener('load', () => resolve(), { once: true }))
  expect(errors.map(error => error.message)).toEqual([])
  expect(dom.window.document.documentElement.dataset.appReady).toBe('true')
  const document = dom.window.document
  const get = (id: string): any => document.getElementById(bundle.nodeIdMap[id].elementId)
  const route = () => document.documentElement.dataset.appRoute
  const tick = () => new Promise(resolve => setTimeout(resolve, 10))
  return { dom, document, get, storage, requests, errors, route, tick, status: () => document.getElementById('app-status').textContent }
}
function fill(f: Awaited<ReturnType<typeof openApp>>, ids: Record<string, string>, title = 'Review design', email = 'owner@example.test', estimate = '4') {
  f.get(ids.titleInput).value = title; f.get(ids.emailInput).value = email; f.get(ids.estimateInput).value = estimate
}

describe('versioned offline app compiler and actual emitted DOM runtime', () => {
  it('compiles three actual document pages deterministically without mutating the source or static code.export', () => {
    const f = runnableAppFixture(), before = JSON.stringify(f.document)
    const bundle = exportRunnableApp(f.document, { version: 1, app: f.app })
    expect(bundle).toEqual(exportRunnableApp(f.document, { version: 1, app: f.app }))
    expect(JSON.stringify(f.document)).toBe(before)
    expect(bundle.pageIds).toEqual(f.document.pages.map(p => p.id))
    expect(bundle.sourceNodeCount).toBe(Object.keys(f.document.nodes).length)
    expect(new Set(Object.values(bundle.nodeIdMap).map(item => item.elementId)).size).toBe(bundle.sourceNodeCount)
    expect(bundle.html).toContain('script-src \'self\''); expect(bundle.html).toContain('connect-src \'none\''); expect(bundle.html).toContain('form-action \'none\'')
    expect(bundle.html).not.toContain('unsafe-inline'); expect(bundle.html).not.toContain('unsafe-eval')
    expect(bundle.javascript).not.toMatch(/\beval\s*\(|new Function|fetch\s*\(|XMLHttpRequest|WebSocket/)
    expect(exportDesignCode(f.document).html).toContain("script-src 'none'")
    expect(bundle.warnings.some(w => w.code === 'LOCAL_DATA_ONLY')).toBe(true)
  })

  it('runs navigation, typed state, validation, create/edit/delete, cancel and persistence/reopen through real semantic controls', async () => {
    const { bundle, ids } = exportFixture(), f = await openApp(bundle)
    expect(f.route()).toBe('/overview')
    expect(f.get(ids.openTasks).tagName).toBe('BUTTON'); expect(f.get(ids.openTasks).type).toBe('button')
    expect(f.get(ids.taskForm).tagName).toBe('FORM'); expect(f.get(ids.titleInput).tagName).toBe('INPUT')
    expect(f.get(ids.titleInput).getAttribute('aria-label')).toBe('Task title')
    expect(f.get(ids.taskForm).contains(f.get(ids.saveTask))).toBe(true)
    f.get(ids.toggleCompact).click(); expect(f.get(ids.compactValue).textContent).toBe('Compact view: true')
    f.get(ids.openTasks).click(); expect(f.route()).toBe('/tasks')
    expect(f.get(ids.home).parentElement.hidden).toBe(true); expect(f.get(ids.tasks).parentElement.hidden).toBe(false)
    f.get(ids.addTask).click(); expect(f.route()).toBe('/edit')
    f.get(ids.saveTask).click(); expect(f.route()).toBe('/edit')
    expect(f.get(ids.titleInput).getAttribute('aria-invalid')).toBe('true')
    expect(f.document.activeElement).toBe(f.get(ids.titleInput)); expect(f.status()).toContain('correct')
    fill(f, ids, 'ok', 'invalid-email', '0'); f.get(ids.saveTask).click()
    expect(f.document.querySelectorAll('[aria-invalid=true]').length).toBe(3)
    fill(f, ids); f.get(ids.saveTask).click()
    expect(f.route()).toBe('/tasks'); expect(f.get(ids.taskList).textContent).toContain('Review design')
    expect(f.get(ids.count).textContent).toBe('Tasks: 1'); expect(f.status()).toBe('Record created.')
    expect(f.get(ids.taskList).querySelector('button[data-app-command=edit]').getAttribute('aria-label')).toContain('Review design')
    f.get(ids.taskList).querySelector('button[data-app-command=edit]').click()
    expect(f.route()).toBe('/edit'); expect(f.get(ids.titleInput).value).toBe('Review design')
    fill(f, ids, 'Review revised design', 'editor@example.test', '6'); f.get(ids.saveTask).click()
    expect(f.status()).toBe('Record updated.'); expect(f.get(ids.count).textContent).toBe('Tasks: 1')
    expect(f.get(ids.taskList).textContent).toContain('Review revised design')
    f.get(ids.taskList).querySelector('button[data-app-command=edit]').click(); fill(f, ids, 'Cancelled modification'); f.get(ids.cancelEdit).click()
    expect(f.get(ids.taskList).textContent).not.toContain('Cancelled modification')
    f.get(ids.addTask).click(); expect(f.get(ids.titleInput).value).toBe('')
    fill(f, ids, 'Second task'); f.get(ids.saveTask).click()
    const reopened = await openApp(bundle, { stored: Object.fromEntries(f.storage), hash: '#/tasks' })
    expect(reopened.get(ids.taskList).querySelectorAll('li')).toHaveLength(2)
    expect(reopened.get(ids.compactValue).textContent).toBe('Compact view: true')
    expect(reopened.get(ids.taskList).textContent).toContain('Review revised design')
    reopened.get(ids.taskList).querySelector('button[data-app-command=delete]').click()
    expect(reopened.get(ids.count).textContent).toBe('Tasks: 1'); expect(reopened.get(ids.taskList).textContent).not.toContain('Review revised design')
    const again = await openApp(bundle, { stored: Object.fromEntries(reopened.storage), hash: '#/tasks' })
    expect(again.get(ids.taskList).querySelectorAll('li')).toHaveLength(1)
    expect(again.get(ids.taskList).textContent).toContain('Second task')
    expect(f.requests).toEqual(['https://offline.test/styles.css', 'https://offline.test/app.js'])
  })

  it('supports browser hash Back/Forward and unknown-route recovery without external URLs', async () => {
    const { bundle, ids } = exportFixture(), f = await openApp(bundle, { hash: '#/overview' })
    f.get(ids.openTasks).click(); await f.tick(); f.get(ids.addTask).click(); await f.tick()
    f.dom.window.history.back(); await f.tick(); expect(f.route()).toBe('/tasks')
    f.dom.window.history.forward(); await f.tick(); expect(f.route()).toBe('/edit')
    f.dom.window.location.hash = '/unknown'; await f.tick()
    expect(f.route()).toBe('/overview'); expect(f.status()).toContain('Unknown route')
    expect(f.document.querySelectorAll('section[data-app-route]:not([hidden])')).toHaveLength(1)
  })

  it('treats hostile strings as text and omits remote assets/links without carrying their URLs', async () => {
    const f = runnableAppFixture(), attack = '</script><script>globalThis.compromised=1</script><img src=x onerror=alert(1)>'
    f.app.collections[0].records = [{ id: 'hostile', title: attack, email: 'local@example.test', estimate: 2 }]
    f.document.name = attack; f.app.actions[0].label = attack
    const image = paint('#fff', 'image'); image.image = 'https://private.example.test/?secret=do-not-export'
    f.document.nodes[f.ids.home].fills.push(image)
    f.document.nodes[f.ids.intro].textRuns = [{ start: 0, end: 4, link: 'https://remote.example.test/' }]
    const bundle = exportRunnableApp(f.document, { version: 1, app: f.app })
    expect(JSON.stringify(bundle)).not.toContain('private.example.test'); expect(JSON.stringify(bundle)).not.toContain('remote.example.test')
    expect(bundle.javascript).not.toContain('</script>'); expect(bundle.appJson).not.toContain('<script>')
    const dom = await openApp(bundle, { hash: '#/tasks' })
    expect(dom.get(f.ids.taskList).textContent).toContain(attack)
    expect(dom.dom.window.compromised).toBeUndefined(); expect(dom.document.querySelector('img')).toBeNull()
    expect(dom.document.scripts).toHaveLength(1); expect(dom.document.querySelectorAll('[onclick],[onerror],[onload]')).toHaveLength(0)
  })

  it.each([
    ['unknown node', (f: ReturnType<typeof runnableAppFixture>) => { f.app.actions[0].nodeId = uid() }],
    ['wrong route page', (f: ReturnType<typeof runnableAppFixture>) => { f.app.routes[1].pageId = f.document.pages[0].id }],
    ['duplicate route', (f: ReturnType<typeof runnableAppFixture>) => { f.app.routes[1].path = f.app.routes[0].path }],
    ['external route', (f: ReturnType<typeof runnableAppFixture>) => { f.app.routes[0].path = 'https://outside.test' }],
    ['long invalid route', (f: ReturnType<typeof runnableAppFixture>) => { f.app.routes[0].path = '/' + 'a'.repeat(120) + '?' }],
    ['missing collection', (f: ReturnType<typeof runnableAppFixture>) => { f.app.forms[0].collection = 'missing' }],
    ['out-of-form input', (f: ReturnType<typeof runnableAppFixture>) => { f.app.forms[0].fields[0].nodeId = f.ids.heading }],
    ['hidden input', (f: ReturnType<typeof runnableAppFixture>) => { f.document.nodes[f.ids.titleInput].visible = false }],
    ['hidden form ancestor', (f: ReturnType<typeof runnableAppFixture>) => { f.document.nodes[f.ids.taskForm].visible = false }],
    ['wrong edit route', (f: ReturnType<typeof runnableAppFixture>) => { f.app.lists[0].editRoute = '/overview' }],
    ['secret field', (f: ReturnType<typeof runnableAppFixture>) => { f.app.collections[0].fields[0].name = 'api_key' }],
    ['unsupported action', (f: ReturnType<typeof runnableAppFixture>) => { f.app.actions[0].steps = [{ kind: 'eval', code: 'alert(1)' }] as any }],
    ['extra payload', (f: ReturnType<typeof runnableAppFixture>) => { (f.app as any).backend = { url: 'https://outside.test' } }],
  ])('rejects %s without source mutation', (_label, change) => {
    const f = runnableAppFixture(); change(f)
    const before = JSON.stringify(f.document)
    expect(() => exportRunnableApp(f.document, { version: 1, app: f.app })).toThrow()
    expect(JSON.stringify(f.document)).toBe(before)
  })

  it('rejects prototype pollution, version mismatches, aggregate scope limits and getter payloads', () => {
    const f = runnableAppFixture()
    const polluted = JSON.parse(JSON.stringify(f.app)); polluted.state = JSON.parse('{"__proto__":{"polluted":true}}')
    expect(() => exportRunnableApp(f.document, { version: 1, app: polluted })).toThrow('unsafe')
    expect(({} as any).polluted).toBeUndefined()
    expect(() => exportRunnableApp(f.document, { version: 2, app: f.app } as unknown as AppExportOptions)).toThrow('version')
    expect(() => exportRunnableApp(f.document, { version: 1, app: f.app, maxNodes: 20 })).toThrow('total maxNodes')
    const getter = { ...f.app }; let called = false
    Object.defineProperty(getter, 'state', { enumerable: true, get: () => { called = true; return {} } })
    expect(() => exportRunnableApp(f.document, { version: 1, app: getter })).toThrow('unsafe')
    expect(called).toBe(false)
    const sparse = { ...f.app, actions: new Array(1000000) }
    expect(() => exportRunnableApp(f.document, { version: 1, app: sparse })).toThrow('budget')
  })

  it('rejects malformed or schema-incompatible persisted data and does not contaminate another app namespace', async () => {
    const f = exportFixture(), config = JSON.parse(f.bundle.appJson)
    for (const encoded of ['{bad-json', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, schema: config.storageSchema, state: { compact: false }, collections: { tasks: [{ id: 'bad', title: 'x', email: 'x', estimate: 'wrong type' }] } }), `{"version":1,"schema":${JSON.stringify(config.storageSchema)},"state":{"__proto__":{},"compact":false},"collections":{"tasks":[]}}`]) {
      const app = await openApp(f.bundle, { stored: { [config.storageKey]: encoded } })
      expect(app.get(f.ids.count).textContent).toBe('Tasks: 0'); expect(app.status()).toContain('could not be loaded')
      app.get(f.ids.toggleCompact).click(); expect(app.status()).toBe('')
      expect(JSON.parse(app.storage.get(config.storageKey)!).state.compact).toBe(true)
    }
    const original = await openApp(f.bundle); original.get(f.ids.toggleCompact).click()
    f.app.id = 'another-notebook'
    const independent = exportRunnableApp(f.document, { version: 1, app: f.app })
    expect(JSON.parse(independent.appJson).storageKey).not.toBe(config.storageKey)
    const other = await openApp(independent, { stored: Object.fromEntries(original.storage) })
    expect(other.get(f.ids.compactValue).textContent).toBe('Compact view: false')
    f.document.id = uid(); f.app.id = 'project-notebook'
    const otherDocument = exportRunnableApp(f.document, { version: 1, app: f.app })
    expect(JSON.parse(otherDocument.appJson).storageKey).not.toBe(config.storageKey)
  })

  it.each(['denied', 'quota'] as const)('continues actual CRUD in memory with visible %s-storage warning', async failure => {
    const { bundle, ids } = exportFixture(), f = await openApp(bundle, { [failure]: true })
    f.get(ids.openTasks).click(); f.get(ids.addTask).click(); fill(f, ids); f.get(ids.saveTask).click()
    expect(f.get(ids.count).textContent).toBe('Tasks: 1'); expect(f.get(ids.taskList).textContent).toContain('Review design')
    expect(f.status()).toMatch(/tab only|could not be saved/); expect(f.storage.size).toBe(0)
  })

  it('enforces the live 500-record bound while allowing edits/deletes and typed state.set', async () => {
    const source = runnableAppFixture()
    source.app.collections[0].records = Array.from({ length: 500 }, (_, i) => ({ id: `task_${i}`, title: `Existing task ${i}`, email: 'owner@example.test', estimate: 2 }))
    source.app.actions.find(a => a.nodeId === source.ids.toggleCompact)!.steps = [{ kind: 'state.set', key: 'compact', value: true }]
    const f = await openApp(exportRunnableApp(source.document, { version: 1, app: source.app }))
    f.get(source.ids.toggleCompact).click(); expect(f.get(source.ids.compactValue).textContent).toBe('Compact view: true')
    f.get(source.ids.openTasks).click(); f.get(source.ids.addTask).click(); fill(f, source.ids); f.get(source.ids.saveTask).click()
    expect(f.status()).toContain('500-record limit'); expect(f.get(source.ids.count).textContent).toBe('Tasks: 500')
    f.get(source.ids.cancelEdit).click(); f.get(source.ids.taskList).querySelector('[data-app-command=delete]').click()
    expect(f.get(source.ids.count).textContent).toBe('Tasks: 499')
    f.get(source.ids.addTask).click(); fill(f, source.ids, 'Now fits'); f.get(source.ids.saveTask).click()
    expect(f.status()).toBe('Record created.'); expect(f.get(source.ids.count).textContent).toBe('Tasks: 500')
  })

  it('packages exact executable files into a deterministic ZIP and a hash-restricted, opaque-origin preview contract', async () => {
    const { bundle, ids } = exportFixture(), bytes = appExportZip(bundle), files = unzipSync(bytes)
    expect(bytes).toEqual(appExportZip(bundle))
    expect(Object.keys(files).sort()).toEqual(['README.md', 'app.js', 'app.json', 'design-manifest.json', 'index.html', 'styles.css'])
    expect(strFromU8(files['app.js'])).toBe(bundle.javascript)
    const f = await openApp({ ...bundle, html: strFromU8(files['index.html']), css: strFromU8(files['styles.css']), javascript: strFromU8(files['app.js']) })
    f.get(ids.openTasks).click(); f.get(ids.addTask).click(); fill(f, ids, 'Created from extracted ZIP'); f.get(ids.saveTask).click()
    expect(f.get(ids.taskList).textContent).toContain('Created from extracted ZIP')
    const preview = sandboxedAppPreview(bundle)
    expect(preview.sandbox).toBe('allow-scripts'); expect(preview.sandbox).not.toContain('allow-same-origin')
    expect(preview.srcDoc).not.toContain('unsafe-inline'); expect(preview.srcDoc).not.toContain('unsafe-eval')
    expect(preview.srcDoc).not.toContain('src="app.js"'); expect(preview.srcDoc).not.toContain('href="styles.css"')
    const script = /<script>([\s\S]*?)<\/script>/.exec(preview.srcDoc)![1], css = /<style>([\s\S]*?)<\/style>/.exec(preview.srcDoc)![1]
    expect(preview.srcDoc).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    expect(preview.srcDoc).toContain(`style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'`)
    expect(preview.srcDoc.match(/Content-Security-Policy/g)).toHaveLength(1)
    const hostileCss = sandboxedAppPreview({ ...bundle, css: bundle.css + '/* </style><script>bad()</script> */' })
    expect(hostileCss.srcDoc.match(/<script>/g)).toHaveLength(1); expect(hostileCss.srcDoc.match(/<\/style>/g)).toHaveLength(1)
  })

  it('keeps the serialized interpreter self-contained after production-style minification', async () => {
    const { rolldown } = await import('rolldown')
    const build = await rolldown({ input: new URL('./app-export-runtime.ts', import.meta.url).pathname })
    try {
      const generated = await build.generate({ format: 'esm', minify: true })
      const code = generated.output.find(item => item.type === 'chunk')!.code
      const compiled = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
      const { bundle, ids } = exportFixture()
      const f = await openApp({ ...bundle, javascript: `(${compiled.startExportedApp.toString()})(${bundle.appJson});` })
      f.get(ids.openTasks).click(); f.get(ids.addTask).click(); fill(f, ids, 'Minified runtime proof'); f.get(ids.saveTask).click()
      expect(f.get(ids.taskList).textContent).toContain('Minified runtime proof')
    } finally { await build.close() }
  })
})

describe('MCP JSON-RPC -> live Editor/WASM -> app resources -> emitted DOM', () => {
  it('discovers the real app.export tool, materializes exact inert resources, and runs local CRUD end to end', async () => {
    const source = runnableAppFixture(), editor = new Editor(source.document), api = createEditorDesignAutomation(editor)
    const backend = new OperationBackend({ capabilities: api.capabilities(), execute: (request: any) => api.execute(request) })
    const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
    let buffer = '', next = 0
    const pending = new Map<number, (value: any) => void>()
    output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(value.id)?.(value); pending.delete(value.id) } })
    diagnostics.resume()
    const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
    cleanups.push(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() })
    const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => reject(new Error('MCP timeout')), 15000)
      pending.set(id, value => { clearTimeout(timer); resolve(value) })
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    expect((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-app-proof', version: '1' } })).result.protocolVersion).toBe('2025-11-25')
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const tools = (await rpc('tools/list')).result.tools
    expect(tools.find((tool: any) => tool.name === 'design_app_export').annotations.readOnlyHint).toBe(true)
    const before = editor.state.version
    const response = (await rpc('tools/call', { name: 'design_app_export', arguments: { params: { version: 1, app: source.app } } })).result
    expect(response.isError, JSON.stringify(response)).toBe(false)
    expect(editor.state.version).toBe(before)
    const projected = response.structuredContent.result
    expect(projected.resourceOnly).toBe(true)
    expect(projected.html).toBeUndefined(); expect(projected.javascript).toBeUndefined()
    const bundle = { ...projected } as Bundle
    for (const ref of projected.resources) {
      const loaded = await rpc('resources/read', { uri: ref.uri })
      expect(loaded.error).toBeUndefined()
      ;(bundle as any)[ref.field] = ref.encoding === 'json' ? JSON.parse(loaded.result.contents[0].text) : loaded.result.contents[0].text
    }
    expect(bundle.html).toBe(exportRunnableApp(editor.state.doc, { version: 1, app: source.app }).html)
    const f = await openApp(bundle)
    f.get(source.ids.openTasks).click(); f.get(source.ids.addTask).click(); fill(f, source.ids, 'Exported through real MCP'); f.get(source.ids.saveTask).click()
    expect(f.get(source.ids.taskList).textContent).toContain('Exported through real MCP')
    if (process.env.APP_EXPORT_EVIDENCE_DIR) {
      const path = process.env.APP_EXPORT_EVIDENCE_DIR
      await mkdir(path, { recursive: true })
      const files = { 'index.html': bundle.html, 'styles.css': bundle.css, 'app.js': bundle.javascript, 'app.json': bundle.appJson, 'README.md': bundle.readme, 'authored-design.json': JSON.stringify(editor.state.doc, null, 2) }
      for (const [name, content] of Object.entries(files)) await writeFile(`${path}/${name}`, content)
      await writeFile(`${path}/offline-project-notebook.zip`, appExportZip(bundle))
      await writeFile(`${path}/verification.json`, JSON.stringify({ mode: 'real Editor/WASM + in-memory MCP JSON-RPC + exact emitted JSDOM runtime', actualBrowser: false, gpu: false, routeCount: source.app.routes.length, pageCount: editor.state.doc.pages.length, nodeCount: bundle.sourceNodeCount, successfulCreatedRecord: 'Exported through real MCP', requests: f.requests, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }])) }, null, 2))
    }
  }, 30000)
})
