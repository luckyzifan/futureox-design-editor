// Run against installed resources and the real bundled Electron executable.
// The bridge dispatch is a fixture; the CLI, socket, and Electron process are not.
// A dev-directory Node process is not a passing result.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>Packaged MCP</title></svg>'
const sourceCli = fileURLToPath(new URL('../../../design-mcp/src/cli.mjs', import.meta.url))
const sourceFigmaCli = fileURLToPath(new URL('../../../design-mcp/src/figma-cli.mjs', import.meta.url))

function redact(text, secret) {
  const value = String(text ?? '')
  return secret ? value.split(secret).join('[redacted]') : value
}

export function stdioClient(command, args, env, { cwd } = {}) {
  const secret = env?.FUTUREOX_DESIGN_BRIDGE_TOKEN
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const lines = createInterface({ input: child.stdout }), pending = new Map()
  const exit = once(child, 'close').catch(() => {})
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4000) stderr = stderr.slice(-4000) })
  child.stdin.on('error', () => {})
  let id = 0
  const failed = () => { for (const { reject } of pending.values()) reject(Error(redact('MCP child closed or sent invalid JSON\n' + stderr, secret))); pending.clear() }
  child.on('error', failed); child.on('close', failed)
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { failed(); child.kill(); return }
    const waiter = pending.get(message.id)
    if (waiter) { pending.delete(message.id); waiter.resolve(message) }
  })
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  return {
    async rpc(method, params = {}) {
      const requestId = ++id
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error(redact('MCP timed out: ' + method + '\n' + stderr, secret))), 20000)
          pending.set(requestId, { resolve, reject }); send({ id: requestId, method, params })
        })
      } finally { clearTimeout(timer); pending.delete(requestId) }
    },
    async init() {
      const response = await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packaged-local-test', version: '1' } })
      assert.equal(response.result?.protocolVersion, '2025-11-25')
      send({ method: 'notifications/initialized' })
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2500)
      try { await exit } finally { clearTimeout(timer); lines.close() }
    },
  }
}

function method(name, mutates, inputSchema = { type: 'object' }) {
  return { name, description: `Packaged path ${name}`, inputSchema, mutates }
}

function packagedSession(target) {
  let revision = 0
  let nodes = new Map()
  const undo = []
  const methods = [
    method('document.get', false),
    method('node.get', false, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
    method('selection.get', false),
    method('batch.apply', true, { type: 'object', properties: { operations: { type: 'array' } }, required: ['operations'] }),
    method('history.undo', true),
    method('preview.capture', false),
    method('vector.export', false),
  ]
  const identity = () => ({ documentId: target.documentId, session: target.session, revision })
  const fail = (name, code, message) => ({ ok: false, method: name, ...identity(), error: { code, message } })
  const ok = (name, result) => ({ ok: true, method: name, ...identity(), result })
  const copyNodes = source => new Map([...source].map(([id, node]) => [id, { ...node, transform: [...node.transform] }]))
  const apply = operation => {
    if (operation?.method === 'node.create') {
      const params = operation.params ?? {}
      if (typeof params.id !== 'string' || !params.id) return 'node.create requires id'
      const patch = params.patch ?? {}
      nodes.set(params.id, {
        id: params.id, name: patch.name ?? params.kind ?? 'node', kind: params.kind ?? 'rectangle',
        width: params.width ?? 1, height: params.height ?? 1,
        transform: [1, 0, 0, 1, params.x ?? 0, params.y ?? 0],
      })
      return null
    }
    if (operation?.method === 'node.update' || operation?.method === 'node.patch') {
      const params = operation.params ?? {}
      for (const id of params.ids ?? []) {
        const node = nodes.get(id)
        if (!node) return 'missing node'
        const patch = params.patch ?? {}
        if (typeof patch.name === 'string') node.name = patch.name
        const transform = patch.transform
        if (Array.isArray(transform) && transform.length === 6) node.transform = transform.slice()
        else if (transform && typeof transform === 'object') {
          if (typeof transform.x === 'number') node.transform[4] = transform.x
          if (typeof transform.y === 'number') node.transform[5] = transform.y
        }
      }
      return null
    }
    return `unsupported batch operation ${operation?.method}`
  }
  return {
    methods,
    async dispatch(packet) {
      if (packet.kind === 'capabilities') return { ...identity(), capabilities: { version: 1, methods } }
      const request = packet.request ?? {}
      const name = request.method
      if ((name === 'batch.apply' || name === 'history.undo') && request.expectedRevision !== revision) return fail(name, 'conflict', 'stale revision')
      if (name === 'document.get') return ok(name, { name: 'Packaged MCP document', revision })
      if (name === 'node.get') {
        const node = nodes.get(request.params?.id)
        if (!node) return fail(name, 'not_found', 'missing node')
        const copy = { ...node, transform: [...node.transform] }
        return ok(name, { id: node.id, name: node.name, kind: node.kind, width: node.width, height: node.height, node: copy })
      }
      if (name === 'selection.get') return ok(name, { pageId: 'page-1', ids: [...nodes.keys()] })
      if (name === 'batch.apply') {
        const saved = copyNodes(nodes)
        for (const operation of request.params?.operations ?? []) {
          const problem = apply(operation)
          if (problem) { nodes = saved; return fail(name, 'invalid_operation', problem) }
        }
        undo.push(saved)
        revision += 1
        return ok(name, { applied: request.params?.operations?.length ?? 0 })
      }
      if (name === 'history.undo') {
        if (!undo.length) return fail(name, 'nothing_to_undo', 'nothing to undo')
        nodes = undo.pop()
        revision += 1
        return ok(name, { undone: true })
      }
      if (name === 'preview.capture') return ok(name, { format: 'futureox.design-preview.v1', mimeType: 'image/png', width: 1, height: 1, renderer: 'product-cpu-export', dataUrl: `data:image/png;base64,${PNG_BASE64}` })
      if (name === 'vector.export') return ok(name, { format: 'futureox.design-vector.v1', mimeType: 'image/svg+xml', filename: 'design.svg', encoding: 'text', content: SVG })
      return fail(name, 'unsupported_method', 'fixture does not implement ' + name)
    },
  }
}

async function revoked(client, uri) {
  const started = Date.now()
  let last
  while (Date.now() - started < 5000) {
    last = await client.rpc('resources/read', { uri })
    if (last.error?.code === -32000) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(last?.error?.code, -32000)
}

function png(message) {
  const image = message.content?.find(item => item.type === 'image')
  assert.ok(image, 'screenshot response has no image')
  assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG')
  const uri = message.content.find(item => item.type === 'resource_link')?.uri
  assert.equal(typeof uri, 'string')
  return uri
}

export async function verifyPackagedMcpTransport({ resources, executable, hostSource, cwd = tmpdir() }) {
  const host = name => import(pathToFileURL(path.join(hostSource, 'src', name)).href)
  const { LocalAutomationBridge } = await host('automation-bridge.mjs')
  const { startDesktopFigmaMcp, desktopMcpPaths, desktopMcpClientConfig, packagedElectronLaunchEnv } = await host('figma-mcp-host.mjs')
  const probe = spawnSync(executable, ['-e', 'process.stdout.write(process.versions.electron||"")'], {
    env: packagedElectronLaunchEnv(), encoding: 'utf8', timeout: 20000, cwd, windowsHide: true,
  })
  const electron = probe.stdout.trim()
  assert.match(electron, /^\d+\.\d+\.\d+/, redact(`Packaged executable did not start as Electron\n${probe.stderr}`, ''))
  assert.notEqual(await realpath(executable), await realpath(process.execPath), 'The test Node binary is not the packaged Electron executable')
  const target = { documentId: 'packaged-test-document', session: 1, revision: 0 }
  const session = packagedSession(target)
  const bridge = new LocalAutomationBridge({ dispatch: session.dispatch })
  const links = await mkdtemp(path.join(tmpdir(), 'fx-mcp-link-'))
  const clients = []
  let http
  let token = ''
  const steps = []
  const mark = (id, entry) => steps.push({ id, entry, status: 'passed' })
  try {
    const resourceLink = path.join(links, 'resources')
    const executableLink = path.join(links, path.basename(executable))
    await symlink(resources, resourceLink, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(executable, executableLink)
    bridge.setEditor({ documentId: target.documentId, session: target.session, name: 'Transport fixture', methods: session.methods })
    const grant = await bridge.enable('write')
    token = grant.token
    http = await startDesktopFigmaMcp(grant, resources)
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + grant.token }
    const post = async message => fetch(http.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...message }), signal: AbortSignal.timeout(8000) })
    assert.equal((await (await post({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'package', version: '1' } } })).json()).result.protocolVersion, '2025-11-25')
    await post({ method: 'notifications/initialized' })
    const listed = await (await post({ id: 2, method: 'tools/list' })).json()
    assert.ok(listed.result.tools.some(tool => tool.name === 'download_assets'))
    const endpoints = desktopMcpPaths(resourceLink)
    const cliReal = await realpath(endpoints.cli)
    const figmaReal = await realpath(endpoints.figmaCli)
    const resourcesReal = await realpath(resources)
    assert.ok(cliReal.startsWith(resourcesReal + path.sep) && cliReal.endsWith(path.join('design-mcp', 'src', 'cli.mjs')))
    assert.ok(figmaReal.startsWith(resourcesReal + path.sep) && figmaReal.endsWith(path.join('design-mcp', 'src', 'figma-cli.mjs')))
    assert.notEqual(cliReal, await realpath(sourceCli), 'Dev-directory cli.mjs is not the packaged entry')
    assert.notEqual(figmaReal, await realpath(sourceFigmaCli), 'Dev-directory figma-cli.mjs is not the packaged entry')
    assert.equal(createHash('sha256').update(await readFile(cliReal)).digest('hex'), createHash('sha256').update(await readFile(sourceCli)).digest('hex'))
    assert.equal(createHash('sha256').update(await readFile(figmaReal)).digest('hex'), createHash('sha256').update(await readFile(sourceFigmaCli)).digest('hex'))
    assert.notEqual(endpoints.cli, cliReal, 'The launched adapter path must be able to traverse a symlink')
    assert.notEqual(executableLink, await realpath(executableLink))
    const config = desktopMcpClientConfig(grant, endpoints.cli, executableLink).mcpServers.futureox_design
    assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(config.env.NODE_OPTIONS, undefined)
    assert.equal('LD_PRELOAD' in config.env, false)
    assert.equal(Object.keys(config.env).some(key => key.startsWith('FUTUREOX_MCP_')), false)
    assert.equal(await realpath(config.command), await realpath(executable))
    const call = async (client, name, args) => {
      const response = await client.rpc('tools/call', { name, arguments: args })
      assert.equal(response.error, undefined, name)
      assert.equal(response.result?.isError, false, name + ' ' + JSON.stringify(response.result?.structuredContent?.error ?? response.result))
      return response.result
    }
    const fence = async client => {
      const document = (await call(client, 'design_document_get', {})).structuredContent
      return { documentId: document.documentId, session: document.session, expectedRevision: document.revision }
    }
    const design = stdioClient(config.command, [endpoints.cli], config.env, { cwd })
    clients.push(design)
    await design.init(); mark('handshake', 'cli.mjs')
    const designTools = (await design.rpc('tools/list')).result.tools.map(tool => tool.name)
    for (const name of ['design_document_get', 'design_node_get', 'design_batch_apply', 'design_preview_capture', 'design_history_undo', 'design_vector_export']) assert.ok(designTools.includes(name), name)
    const read = await call(design, 'design_document_get', {})
    assert.equal(read.structuredContent.result.name, 'Packaged MCP document')
    mark('read', 'cli.mjs')
    const id = 'card-1'
    await call(design, 'design_batch_apply', { params: { operations: [{ method: 'node.create', params: { id, kind: 'rectangle', width: 130, height: 45, patch: { name: 'External MCP card' } } }] }, ...(await fence(design)) })
    assert.equal((await call(design, 'design_node_get', { params: { id } })).structuredContent.result.node.name, 'External MCP card')
    await call(design, 'design_batch_apply', { params: { operations: [{ method: 'node.update', params: { ids: [id], patch: { transform: [1, 0, 0, 1, 100, 200] } } }] }, ...(await fence(design)) })
    assert.deepEqual((await call(design, 'design_node_get', { params: { id } })).structuredContent.result.node.transform.slice(4), [100, 200])
    mark('edit', 'cli.mjs')
    const vector = await call(design, 'design_vector_export', { params: {} })
    const vectorUri = vector.content.find(item => item.type === 'resource_link').uri
    assert.equal((await design.rpc('resources/read', { uri: vectorUri })).result.contents[0].text, SVG)
    const shot = await call(design, 'design_preview_capture', { params: { nodeIds: [id], format: 'png' } })
    const shotUri = png(shot)
    assert.equal((await design.rpc('resources/read', { uri: shotUri })).result.contents[0].blob, PNG_BASE64)
    mark('screenshot', 'cli.mjs')
    await call(design, 'design_history_undo', { params: {}, ...(await fence(design)) })
    assert.deepEqual((await call(design, 'design_node_get', { params: { id } })).structuredContent.result.node.transform.slice(4), [0, 0])
    mark('undo', 'cli.mjs')
    const figma = stdioClient(config.command, [endpoints.figmaCli], { ...config.env }, { cwd })
    clients.push(figma)
    await figma.init(); mark('handshake', 'figma-cli.mjs')
    const figmaTools = (await figma.rpc('tools/list')).result.tools.map(tool => tool.name)
    for (const name of ['get_selection', 'use_figma', 'get_screenshot', 'download_assets']) assert.ok(figmaTools.includes(name), name)
    const selection = await call(figma, 'get_selection', {})
    assert.equal(selection.structuredContent.result.nodes[0].name, 'External MCP card')
    mark('read', 'figma-cli.mjs')
    const edited = await call(figma, 'use_figma', { description: 'Move card', operations: [{ op: 'update', nodeId: id, x: 80, y: 40 }] })
    assert.equal(edited.structuredContent.ok, true)
    assert.deepEqual((await call(design, 'design_node_get', { params: { id } })).structuredContent.result.node.transform.slice(4), [80, 40])
    mark('edit', 'figma-cli.mjs')
    const asset = await call(figma, 'download_assets', { nodeId: id, defaultFormat: 'svg' })
    const assetUri = asset.content.find(item => item.type === 'resource_link').uri
    assert.equal((await figma.rpc('resources/read', { uri: assetUri })).result.contents[0].text, SVG)
    const figmaShot = await call(figma, 'get_screenshot', { nodeId: id })
    const figmaShotUri = png(figmaShot)
    mark('screenshot', 'figma-cli.mjs')
    await call(design, 'design_history_undo', { params: {}, ...(await fence(design)) })
    assert.deepEqual((await call(design, 'design_node_get', { params: { id } })).structuredContent.result.node.transform.slice(4), [0, 0])
    mark('undo', 'cli.mjs-after-figma-edit')
    await bridge.close()
    await revoked(design, shotUri); mark('revoke_rejects_old_resource', 'cli.mjs')
    await revoked(figma, figmaShotUri); mark('revoke_rejects_old_resource', 'figma-cli.mjs')
    assert.equal((await (await post({ id: 3, method: 'resources/list' })).json()).error?.code, -32000)
    const report = {
      schema: 1, issue: 84, electron, devDirectoryCli: false, toolsListAlone: false, envReplaced: true,
      launchedThroughSymlink: true, externalClientAcceptance: false, editorGui: 'not_run',
      cliSha256: createHash('sha256').update(await readFile(cliReal)).digest('hex'), steps,
    }
    assert.equal(JSON.stringify(report).includes(token), false)
    return report
  } catch (error) {
    if (token && error?.message) error.message = redact(error.message, token)
    throw error
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await http?.close()
    await bridge.close()
    await rm(links, { recursive: true, force: true })
  }
}
