// node test/packaged-local-mcp.mjs /absolute/path/to/packaged/executable [--clients]
// Uses an isolated profile, accepts native dialogs inside that test process only,
// and intercepts clipboard writes in memory. Never put the connection JSON in a log.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stdioClient } from './runtime/packaged-mcp-transport.mjs'
const require = createRequire(new URL('../../design-client/package.json', import.meta.url))
const { _electron, expect } = require('@playwright/test')
const executablePath = await realpath(process.argv[2])
const temp = await mkdtemp(path.join(await realpath(tmpdir()), 'fxm-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k)))
const clients = []
let app
try {
  app = await _electron.launch({ executablePath, args: ['--desktop-gui-test', '--core-cpu-only'], env: { ...env, TMPDIR: temp }, chromiumSandbox: true })
  const page = await app.firstWindow()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready', 'true', { timeout: 45000 })
  const profile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.ok((await realpath(profile)).startsWith(temp + path.sep))
  await app.evaluate(({ dialog, clipboard }) => {
    dialog.showMessageBox = async (...args) => ({ response: args.at(-1).title === 'Local design automation' ? 1 : 0 })
    clipboard.writeText = s => { globalThis.mcpTestCopy = s }
  })
  if (await page.locator('.local-home').isVisible()) await page.getByRole('button', { name: /继续编辑|Continue editing/i }).click()
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().items.flatMap(i => i.submenu?.items ?? []).find(i => /MCP connection and permissions|MCP 连接与权限/.test(i.label))
    if (!item) throw Error('No native MCP menu'); item.click()
  })
  const dialog = page.locator('.automation-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^(启用只读|Enable read-only)$/ }).click()
  async function copy(format) {
    await app.evaluate(() => { globalThis.mcpTestCopy = undefined })
    await dialog.getByRole('button', { name: format }).click()
    const raw = await app.evaluate(() => { const s = globalThis.mcpTestCopy; delete globalThis.mcpTestCopy; return s })
    assert.ok(typeof raw === 'string', 'Config must be explicitly copied')
    return raw
  }
  const stdioButton = /复制 stdio 客户端配置|Copy stdio client config/
  const start = async config => {
    const c = stdioClient(config.command, config.args, config.env); clients.push(c); await c.init(); return c
  }
  const readConfig = JSON.parse(await copy(stdioButton)).mcpServers.futureox_design
  assert.equal(await realpath(readConfig.command), executablePath)
  const ro = await start(readConfig)
  const rtools = (await ro.rpc('tools/list')).result.tools
  assert.ok(rtools.some(t => t.name === 'design_document_get'))
  assert.ok(!rtools.some(t => t.name === 'design_node_create' || t.name === 'design_workspace_list'))
  await ro.close(); clients.pop()
  const selects = dialog.locator('select')
  await selects.nth(0).selectOption('write'); await selects.nth(1).selectOption('write')
  await dialog.getByRole('button', { name: /^(启用读写|Enable read and write)$/ }).click()
  const config = JSON.parse(await copy(stdioButton)).mcpServers.futureox_design
  const toml = await copy(/复制 Codex TOML|Copy Codex TOML/)
  assert.ok(toml.includes('[mcp_servers.futureox_design.env]') && toml.includes(config.env.FUTUREOX_DESIGN_BRIDGE_TOKEN))
  const details = JSON.parse(await copy(/复制连接详情|Copy connection details/))
  assert.notEqual(config.env.FUTUREOX_DESIGN_SESSION, readConfig.env.FUTUREOX_DESIGN_SESSION)
  const client = await start(config)
  const tools = (await client.rpc('tools/list')).result.tools
  for (const name of ['design_node_create', 'design_preview_capture', 'design_workspace_save', 'design_settings_update']) assert.ok(tools.some(t => t.name === name))
  const invoke = async (name, params = {}, fence = {}) => {
    const r = await client.rpc('tools/call', { name, arguments: { params, ...fence } })
    assert.ok(!r.error && r.result?.isError === false, name + ': ' + (r.result?.structuredContent?.error?.code || r.error?.code || 'failure'))
    return r.result
  }
  const fence = async () => { const d = (await invoke('design_document_get')).structuredContent; return { documentId: d.documentId, session: d.session, expectedRevision: d.revision } }
  const id = randomUUID()
  await invoke('design_batch_apply', { operations: [{ method: 'node.create', params: { id, kind: 'rectangle', width: 130, height: 45, patch: { name: 'External MCP card' } } }] }, await fence())
  assert.equal((await invoke('design_node_get', { id })).structuredContent.result.node.name, 'External MCP card')
  // Also check the actual packaged HTTP facade + its resource ownership (real editor, real exports).
  let serial = 0
  const post = async (method, params, note = false) => {
    const r = await fetch(details.figmaMcp.url, { method: 'POST', headers: { authorization: 'Bearer ' + details.token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...note ? {} : { id: ++serial }, method, params }), signal: AbortSignal.timeout(15000) })
    assert.equal(r.status, note ? 202 : 200); if (!note) return (await r.json()).result
  }
  await post('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-package', version: '1' } })
  await post('notifications/initialized', {}, true)
  const fc = await post('tools/call', { name: 'get_design_context', arguments: { nodeId: id } })
  for (const mime of ['text/html', 'text/css']) {
    const uri = fc.content.find(x => x.type === 'resource_link' && x.mimeType === mime)?.uri
    assert.ok(uri, mime); assert.ok((await post('resources/read', { uri })).contents[0].text.length)
  }
  const moved = await post('tools/call', { name: 'use_figma', arguments: { description: 'Place card', operations: [{ op: 'update', nodeId: id, x: 100 }, { op: 'update', nodeId: id, y: 200 }] } })
  assert.equal(moved.isError, false)
  assert.deepEqual((await invoke('design_node_get', { id })).structuredContent.result.node.transform.slice(4), [100, 200])
  const shot = await invoke('design_preview_capture', { nodeIds: [id], format: 'png' }, await fence())
  const image = shot.content.find(x => x.type === 'image')
  assert.ok(image && Buffer.from(image.data, 'base64').subarray(1,4).toString() === 'PNG')
  const uri = shot.content.find(x => x.type === 'resource_link').uri
  await invoke('design_history_undo', {}, await fence())
  assert.deepEqual((await invoke('design_node_get', { id })).structuredContent.result.node.transform.slice(4), [0,0])
  if (process.argv.includes('--clients')) {
    const { verifyExternalClients } = await import('./runtime/external-mcp-clients.mjs')
    await verifyExternalClients(config, temp)
  }
  await invoke('design_history_undo', {}, await fence())
  await dialog.getByRole('button', { name: /^(停用|Turn off)$/ }).click()
  await expect.poll(async () => (await client.rpc('resources/read', { uri })).error?.code).toBe(-32000)
  console.log(JSON.stringify({ packagedGui: true, readTools: rtools.length, fullGrantTools: tools.length, nativeMenu: true, htmlCss: true, sameBatchXY: true, png: true, undo: true, revoked: true }))
} finally {
  await Promise.allSettled(clients.map(c => c.close()))
  try { await app?.close() } finally { await rm(temp, { recursive: true, force: true }) }
}
