// Actual official SDK and stdio subprocess, production protocol server but
// deterministic backend. This is NOT the desktop socket/Editor/GUI layer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const sdkRoot = process.env.MCP_OFFICIAL_SDK_ROOT
const sdk = sdkRoot ? createRequire(path.join(sdkRoot, 'package.json')) : undefined
const Client = sdk?.('@modelcontextprotocol/client').Client, StdioClientTransport = sdk?.('@modelcontextprotocol/client/stdio').StdioClientTransport
const fixture = fileURLToPath(new URL('./modern-sdk-fixture.mjs', import.meta.url))
for (const mode of ['auto', 'pinned-modern', 'legacy']) test(`official SDK ${mode}: actual stdio and fixture backend`, { skip: !sdkRoot, timeout: 20000 }, async () => {
  const evidence = process.env.MCP_EVIDENCE_DIR ?? await mkdtemp(path.join(tmpdir(), 'modern-stdio-evidence-'))
  await mkdir(evidence, { recursive: true })
  const tracePrefix = path.join(evidence, `stdio-${mode}`)
  const options = mode === 'auto' ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 3000, maxRetries: 0 } } } : mode === 'pinned-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
  const client = new Client({ name: 'official-stdio-fixture', version: '1' }, options)
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture], env: { PATH: process.env.PATH, MCP_FIXTURE_TRACE: tracePrefix }, stderr: 'pipe' })
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk })
  try {
    await client.connect(transport)
    assert.equal(client.getProtocolEra(), mode === 'legacy' ? 'legacy' : 'modern')
    assert.deepEqual(client.getServerCapabilities(), { tools: {}, resources: {}, prompts: {} })
    assert.equal((await client.listTools()).tools[0].name, 'fixture_export')
    const value = await client.callTool({ name: 'fixture_export', arguments: {} })
    const link = value.content.find(c => c.type === 'resource_link'); assert.ok(link)
    assert.equal((await client.readResource({ uri: link.uri })).contents[0].text, '{"fixture":true}')
    const resources = (await client.listResources()).resources
    assert.equal(resources.some(r => r.uri === link.uri), mode === 'legacy')
    assert.equal((await client.listPrompts()).prompts.length, 2)
    assert.equal((await client.getPrompt({ name: 'design_generation', arguments: { brief: 'fixture' } })).messages[0].role, 'user')
    assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, [])
    await assert.rejects(client.readResource({ uri: 'missing' }), error => error.code === (mode === 'legacy' ? -32002 : -32602))
  } finally { await client.close() }
  const files = (await readdir(evidence)).filter(name => name.startsWith(`stdio-${mode}-`) && name.endsWith('.ndjson'))
  const records = (await Promise.all(files.map(name => readFile(path.join(evidence, name), 'utf8')))).map(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
  const packets = []
  for (const child of records) {
    // stdin chunks may split/coalesce frames; concatenate per direction first.
    for (const direction of ['input', 'output']) {
      const stream = child.filter(r => r.kind === direction).map(r => r.data).join('')
      packets.push(...stream.split('\n').filter(Boolean).map(line => ({ direction, message: JSON.parse(line) })))
    }
  }
  const requests = packets.filter(p => p.direction === 'input').map(p => p.message)
  const results = packets.filter(p => p.direction === 'output' && p.message.result).map(p => p.message.result)
  assert.ok(results.length > 0)
  if (mode === 'legacy') {
    assert.ok(requests.some(r => r.method === 'initialize'))
    assert.ok(results.every(r => r.resultType === undefined))
  } else {
    assert.equal(requests.some(r => r.method === 'initialize'), false)
    assert.ok(results.every(r => r.resultType === 'complete'))
    assert.ok(results.some(r => r.tools && r.ttlMs === 0 && r.cacheScope === 'private'))
    assert.ok(requests.filter(r => 'id' in r).every(r => r.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'))
    if (mode === 'auto') {
      assert.ok(requests.some(r => r.method === 'server/discover'))
      const probeOnly = records.filter(child => !child.some(r => r.kind === 'backend-list'))
      assert.ok(probeOnly.length >= 1, 'Auto short-lived probe must not call backend')
      assert.ok(probeOnly.every(child => !child.some(r => r.kind === 'backend-call')))
    }
  }
  assert.equal(stderr, '')
  await writeFile(path.join(evidence, `stdio-${mode}-summary.json`), JSON.stringify({ mode, boundary: 'official SDK / actual stdio / production protocol / deterministic fixture backend; no real bridge or Editor', processes: records.length, requestCount: requests.length, resultCount: results.length, stderr }, null, 2) + '\n')
})
