// Electron-side client for the Tokio design-agent. The binary serves loopback
// HTTP; this module is the only process that stores provider secrets on disk.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const fail = (error, code = error?.code || 'AGENT') => ({ status: 'error', code, message: error?.message || '设计助手不可用' })

export function createDesignAgentHost({ bin, port = 3927, storePath, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  let child = null
  let base = ''
  let starting = null
  const root = () => `http://127.0.0.1:${port}`
  const store = () => typeof storePath === 'function' ? storePath() : storePath

  async function waitUntilReady(proc) {
    const deadline = Date.now() + 8000
    let last = '设计助手没有在 8 秒内就绪'
    while (Date.now() < deadline) {
      if (proc.exitCode != null) throw Object.assign(new Error(last), { code: 'AGENT_EXIT' })
      try {
        const response = await fetchImpl(`${root()}/health`)
        if (response.ok) return
        last = `设计助手健康检查返回 ${response.status}`
      } catch (error) { last = error.message }
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    throw Object.assign(new Error(last), { code: 'AGENT_TIMEOUT' })
  }

  async function ensure() {
    if (base) return base
    if (!starting) starting = (async () => {
      if (!bin) throw Object.assign(new Error('未找到 futureox-design-agent。在 design-studio 执行 cargo build -p futureox-design-agent。'), { code: 'AGENT_BIN' })
      child = spawn(bin, ['serve', '--bind', `127.0.0.1:${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-500) })
      try { await waitUntilReady(child) }
      catch (error) { throw Object.assign(error, { message: stderr.trim() || error.message }) }
      base = root()
      await restore().catch(() => {})
      return base
    })()
    try { return await starting }
    catch (error) { starting = null; child?.kill(); child = null; throw error }
  }

  async function request(method, pathname, body) {
    const url = `${await ensure()}${pathname}`
    const response = await fetchImpl(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(payload.error || `设计助手返回 ${response.status}`), { code: 'AGENT' })
    return payload
  }

  async function postDirect(pathname, body) {
    const response = await fetchImpl(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`设计助手返回 ${response.status}`)
  }

  async function restore() {
    const file = store()
    if (!file || !base) return
    const raw = await readFile(file, 'utf8').catch(() => '')
    if (!raw) return
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved.providers)) return
    await Promise.all(saved.providers.map(provider => postDirect('/v1/providers', provider).catch(() => {})))
    if (saved.active) await postDirect('/v1/providers/activate', { id: saved.active }).catch(() => {})
  }

  async function remember(provider) {
    const file = store()
    if (!file) return
    await mkdir(path.dirname(file), { recursive: true })
    const raw = await readFile(file, 'utf8').catch(() => '')
    const saved = raw ? JSON.parse(raw) : { providers: [], active: provider.id }
    const providers = Array.isArray(saved.providers) ? saved.providers.filter(item => item.id !== provider.id) : []
    providers.push(provider)
    await writeFile(file, JSON.stringify({ providers, active: provider.id }))
  }

  return {
    async status() {
      try {
        const [providers, ccswitch] = await Promise.all([
          request('GET', '/v1/providers'),
          request('GET', '/v1/ccswitch'),
        ])
        return { status: 'ok', providers: providers.providers || [], ccswitch }
      } catch (error) { return fail(error) }
    },
    async turn(value) {
      try { return { status: 'ok', turn: await request('POST', '/v1/turn', value) } }
      catch (error) { return fail(error) }
    },
    async upsert(value) {
      try {
        await request('POST', '/v1/providers', value)
        await remember(value)
        return { status: 'ok' }
      } catch (error) { return fail(error) }
    },
    async activate(value) {
      try {
        await request('POST', '/v1/providers/activate', value)
        const file = store()
        if (file && value?.id) {
          await mkdir(path.dirname(file), { recursive: true })
          const raw = await readFile(file, 'utf8').catch(() => '')
          const saved = raw ? JSON.parse(raw) : { providers: [], active: value.id }
          const providers = Array.isArray(saved.providers) ? saved.providers : []
          if (value.profile_id) {
            const row = providers.find(item => item.id === value.id)
            if (row) row.profile_id = value.profile_id
            else providers.push({ id: value.id, name: 'CC Switch', kind: 'ccswitch', base_url: 'http://127.0.0.1:15721/v1', model: '', secret: '', wire: 'openai_chat', profile_id: value.profile_id })
          }
          await writeFile(file, JSON.stringify({ providers, active: value.id }))
        }
        return { status: 'ok' }
      }
      catch (error) { return fail(error) }
    },
    async remove(value) {
      try { await request('POST', '/v1/providers/remove', value); return { status: 'ok' } }
      catch (error) { return fail(error) }
    },
    async cancel(value) {
      try { await request('POST', '/v1/cancel', value); return { status: 'ok' } }
      catch (error) { return fail(error) }
    },
    dispose() { child?.kill(); child = null; base = ''; starting = null },
  }
}
