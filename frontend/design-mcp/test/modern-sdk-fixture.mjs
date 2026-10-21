// Fixture backend only. Actual production framing, admission, codec and stdio.
import { DesignMcpServer } from '../src/server.mjs'
import { appendFileSync } from 'node:fs'
const record = (kind, data) => { if (process.env.MCP_FIXTURE_TRACE) appendFileSync(`${process.env.MCP_FIXTURE_TRACE}-${process.pid}.ndjson`, JSON.stringify({ kind, data }) + '\n') }
process.stdin.on('data', chunk => record('input', chunk.toString()))
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => { record('output', chunk.toString()); return write(chunk, ...args) }
const descriptor = { name: 'fixture_export', description: 'Deterministic protocol fixture, not product Editor', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
const backend = {
  listTools: async () => { record('backend-list', {}); return [descriptor] },
  callTool: async () => { record('backend-call', {}); return { ok: true, method: 'document.export', revision: 1, result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content: '{"fixture":true}' } } },
  close: () => record('backend-close', {}),
}
const server = new DesignMcpServer({ backend }).start()
process.once('SIGTERM', () => { void server.close() }); process.once('SIGINT', () => { void server.close() })
await server.done
record('done', {})
