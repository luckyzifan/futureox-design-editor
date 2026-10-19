// Local validation only. Uses the production renderer/host policy without a
// debugger, Node integration or access to the developer's normal profile.
import path from 'node:path'
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises'
import { isAppResource } from './security.mjs'

const entries = {
  interaction: 'interaction-surface-check.html', zoom: 'zoom-clarity-check.html',
  alignment: 'canvas-alignment-check.html', seams: 'display-seams-check.html',
  reference: 'figma-reference-check.html',
  optical: 'optical-field-check.html',
  order: 'display-order-check.html',
}
export function renderCheckConfig(argv, packaged = false) {
  const option = name => argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
  const entry = option('--desktop-render-check')
  if (entry === undefined) return undefined
  if (packaged || !argv.includes('--desktop-isolated-profile')) throw Error('Render checks require an unpackaged isolated profile')
  if (!Object.hasOwn(entries, entry)) throw Error('Unknown render check')
  const rendererRoot = option('--desktop-render-check-root'), fixture = option('--desktop-render-check-fixture')
  if (!rendererRoot || !path.isAbsolute(rendererRoot) || !fixture || !path.isAbsolute(fixture)) throw Error('Render checks require explicit absolute bundle and fixture paths')
  const query = option('--desktop-render-check-query') || ''
  if (query.length > 4096 || /[#\r\n]/.test(query)) throw Error('Invalid render check query')
  return { entry, rendererRoot, fixture, url: `design-app://app/${entries[entry]}${query ? `?${query}` : ''}` }
}

async function boundedBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw Error('Render check result is too large')
  const chunks = [], reader = request.body?.getReader()
  if (!reader) throw Error('Missing render check result')
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); throw Error('Render check result is too large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, length)
}

export function renderCheckHandler(config, output, environment) {
  if (!config) return async () => undefined
  let writes = Promise.resolve(), sequence = 0
  return async request => {
    const url = new URL(request.url)
    if (!isAppResource(request.url)) return undefined
    if (request.method === 'GET' && url.pathname === '/__render_environment')
      return Response.json(environment())
    if (request.method === 'GET' && url.pathname === '/__render_fixture') {
      const info = await stat(config.fixture)
      if (!info.isFile() || info.size > 64 * 1024 * 1024) throw Error('Invalid render check fixture')
      const bytes = await readFile(config.fixture)
      if (bytes.length > 64 * 1024 * 1024) throw Error('Render check fixture is too large')
      return new Response(bytes, { headers: { 'Content-Type': 'application/json' } })
    }
    const report = /^\/__render_report(?:_interaction|_pan)?$/.test(url.pathname)
    const image = url.pathname === '/__precision_image' && /^pose-\d+-(live|fresh)$/.test(url.searchParams.get('name') || '')
    if (request.method !== 'POST' || !report && !image) return undefined
    if (++sequence > 256) throw Error('Render check output budget exceeded')
    const id = sequence, name = report ? `${String(id).padStart(3, '0')}-report.json` : `${url.searchParams.get('name')}.png`
    // Serialize completion too: a late earlier POST cannot replace the final report.
    const work = writes.then(async () => {
      const bytes = await boundedBody(request, image ? 16 * 1024 * 1024 : 4 * 1024 * 1024)
      if (report && typeof JSON.parse(bytes).status !== 'string') throw Error('Invalid render check report')
      if (image && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Expected PNG result')
      await mkdir(output, { recursive: true })
      const target = path.join(output, name)
      await writeFile(`${target}.tmp`, bytes)
      await rename(`${target}.tmp`, target)
    })
    writes = work.catch(() => {}) // Keep later diagnostics writable after a failed result.
    await work
    return new Response('ok')
  }
}
