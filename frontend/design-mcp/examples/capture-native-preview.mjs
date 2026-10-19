#!/usr/bin/env node
/** Manual, read-only acceptance helper. Not run in the restricted cloud test.
 * Without --run, this file reads no credentials and opens no process/socket. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const args = process.argv.slice(2)
if (!args.includes('--run')) {
  process.stdout.write('Manual native preview check (read-only):\n  node capture-native-preview.mjs --run --output ABSOLUTE_NEW_DIRECTORY [--scale 1] [--page-id ID]\nRun only on the authorized desktop with its bridge already enabled and FUTUREOX_DESIGN_SOCKET, FUTUREOX_DESIGN_SESSION and FUTUREOX_DESIGN_BRIDGE_TOKEN supplied through the process environment. Never paste or save the token in this repository.\nThis proves native stdio/socket + product CPU preview only; GPU/display screenshots require separate visual acceptance.\n')
} else {
  const options = { scale: 1 }
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--run') continue
    if (!['--output', '--scale', '--page-id'].includes(key) || !args[index + 1]) throw Error('Use --run --output ABSOLUTE_NEW_DIRECTORY [--scale 1] [--page-id ID]')
    options[key.slice(2)] = args[++index]
  }
  options.scale = Number(options.scale)
  if (!options.output || !path.isAbsolute(options.output) || !Number.isFinite(options.scale) || options.scale < 0.1 || options.scale > 4) throw Error('Absolute output directory and scale between 0.1 and 4 are required')
  for (const key of ['FUTUREOX_DESIGN_SOCKET', 'FUTUREOX_DESIGN_SESSION', 'FUTUREOX_DESIGN_BRIDGE_TOKEN']) if (!process.env[key]) throw Error(`Missing ${key}; configure the already-enabled desktop bridge locally`)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  // Diagnostics may contain private endpoint details, so never copy them to evidence.
  child.stderr.resume()
  const pending = new Map(), transcript = []
  let sequence = 0, buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 34 * 1024 * 1024) { child.kill(); return }
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      const waiter = pending.get(message.id); pending.delete(message.id); waiter?.resolve(message)
    }
  })
  const fail = () => { for (const waiter of pending.values()) waiter.reject(Error('Native MCP process ended before completion')); pending.clear() }
  child.on('error', fail); child.on('exit', fail)
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Native request ${id} timed out`)) }, 65000)
    pending.set(id, { resolve: response => { clearTimeout(timer); transcript.push({ id, method, bytes: Buffer.byteLength(JSON.stringify(response)), error: !!response.error }); resolve(response) }, reject: error => { clearTimeout(timer); reject(error) } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const checked = response => { if (response.error) throw Error('Native MCP returned a protocol error; inspect locally without sharing credentials'); return response.result }
  try {
    checked(await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'manual-native-preview-acceptance', version: '1' } }))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const catalog = checked(await rpc('tools/list', {}))
    if (!catalog.tools.some(tool => tool.name === 'design_preview_capture')) throw Error('The enabled native session does not expose preview.capture')
    const document = checked(await rpc('tools/call', { name: 'design_document_get', arguments: {} })).structuredContent
    if (!document.ok) throw Error('Native document inspection failed')
    const preview = checked(await rpc('tools/call', { name: 'design_preview_capture', arguments: {
      documentId: document.documentId, session: document.session, expectedRevision: document.revision,
      params: { format: 'png', scale: options.scale, ...(options['page-id'] ? { pageId: options['page-id'] } : {}) },
    } }))
    const value = preview.structuredContent
    if (preview.isError || !value?.ok) throw Error(`Native preview failed: ${value?.error?.code ?? 'unknown'}; no substitute image was saved`)
    const result = value.result, ref = result.resources?.find(resource => resource.field === 'dataUrl')
    if (!ref || result.mimeType !== 'image/png' || result.backend !== 'cpu' || result.renderer !== 'product-cpu-export' || result.scale !== options.scale || result.revision !== document.revision) throw Error('Native preview metadata is inconsistent')
    const content = checked(await rpc('resources/read', { uri: ref.uri })).contents[0]
    const bytes = Buffer.from(content.blob, 'base64'), inline = preview.content.find(item => item.type === 'image')
    if (inline && inline.data !== content.blob) throw Error('Inline image and resource bytes differ')
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== result.width || bytes.readUInt32BE(20) !== result.height || bytes.length !== result.bytes) throw Error('PNG signature, dimensions or byte count mismatch')
    await mkdir(options.output, { recursive: true })
    await writeFile(path.join(options.output, 'native-product-cpu-preview.png'), bytes, { flag: 'wx' })
    await writeFile(path.join(options.output, 'native-acceptance.json'), JSON.stringify({
      scope: 'Actual native desktop renderer bridge and OS stdio/socket; CPU design-content preview only', capturedAt: new Date().toISOString(),
      gpuDisplayAcceptance: 'NOT TESTED by this helper', screenshot: false, externalModel: 'not used',
      metadata: { ...result, resources: undefined }, sha256: createHash('sha256').update(bytes).digest('hex'), inlineImage: !!inline, transcript,
    }, null, 2) + '\n', { flag: 'wx' })
    process.stdout.write('Saved exact native CPU preview and bounded acceptance evidence. GPU/display screenshots still require separate acceptance.\n')
  } finally { child.stdin.end(); child.kill() }
}
