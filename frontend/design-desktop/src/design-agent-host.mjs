// Electron-side client for the Tokio design-agent. The binary serves loopback
// HTTP; this module is the only process that stores provider secrets on disk.
// Spawn failures stay inside the returned DesktopResult. A ChildProcess 'error'
// event with no listener becomes an uncaught exception, so the listener is
// attached synchronously before the first await.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const fail = (error, code = error?.code || 'AGENT') => ({
  status: 'error',
  code: typeof code === 'string' && code ? code : 'AGENT',
  message: String(error?.message || '设计助手不可用').slice(0, 500),
})

export function resolveDesignAgentBinary({ env = process.env, resourcesRoot, platform = process.platform } = {}) {
  if (env.DESIGN_AGENT_BIN) return env.DESIGN_AGENT_BIN
  const filename = `futureox-design-agent${platform === 'win32' ? '.exe' : ''}`
  return path.join(resourcesRoot, 'bin', filename)
}

function classifySpawn(error, bin) {
  if (error?.code === 'ENOENT') {
    return Object.assign(new Error(`未找到设计助手程序（${bin}）。请重新构建桌面版。`), { code: 'AGENT_BIN' })
  }
  return Object.assign(new Error(`设计助手无法启动：${error?.message || '未知错误'}`), { code: 'AGENT_SPAWN' })
}

function classifyExit(info, stderr, port) {
  const text = String(stderr || '').trim()
  if (/AGENT_PORT|EADDRINUSE|address already in use|AddrInUse/i.test(text)) {
    return Object.assign(new Error(`设计助手端口 ${port} 已被占用。${text}`.trim()), { code: 'AGENT_PORT' })
  }
  const why = text || `退出码 ${info?.code ?? info?.signal ?? 'unknown'}`
  return Object.assign(new Error(`设计助手已退出。${why}`), { code: 'AGENT_EXIT' })
}

export function createDesignAgentHost({ bin, port = 3927, storePath, fetchImpl = globalThis.fetch, env = process.env, readyTimeoutMs = 8000, pollMs = 40 } = {}) {
  let child = null
  let base = ''
  let starting = null
  let generation = 0
  const root = () => `http://127.0.0.1:${port}`
  const store = () => typeof storePath === 'function' ? storePath() : storePath

  function stop(proc) {
    if (proc && proc.exitCode == null && proc.signalCode == null) proc.kill()
  }

  async function waitUntilReady(read) {
    const deadline = Date.now() + readyTimeoutMs
    const summary = `设计助手没有在 ${Math.max(1, Math.round(readyTimeoutMs / 1000))} 秒内就绪`
    let last = summary
    await new Promise(resolve => setImmediate(resolve))
    while (Date.now() < deadline) {
      const snap = read()
      if (snap.spawnError) throw classifySpawn(snap.spawnError, bin)
      if (snap.closed) throw classifyExit(snap.closed, snap.stderr, port)
      const attempt = new AbortController()
      const attemptTimer = setTimeout(() => attempt.abort(), Math.min(400, Math.max(50, deadline - Date.now())))
      try {
        const response = await fetchImpl(`${root()}/health`, { signal: attempt.signal })
        if (!response.ok) throw Object.assign(new Error(`设计助手健康检查返回 ${response.status}`), { code: 'AGENT_HEALTH' })
        const body = await response.json().catch(() => null)
        if (body?.ok === true && body?.service === 'futureox-design-agent') return
        throw Object.assign(new Error('设计助手健康检查返回了无法识别的内容'), { code: 'AGENT_HEALTH' })
      } catch (error) {
        if (error?.code === 'AGENT_HEALTH') throw error
        const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
        if (!aborted) last = error?.message || last
      } finally {
        clearTimeout(attemptTimer)
      }
      const again = read()
      if (again.spawnError) throw classifySpawn(again.spawnError, bin)
      if (again.closed) throw classifyExit(again.closed, again.stderr, port)
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    const snap = read()
    if (snap.spawnError) throw classifySpawn(snap.spawnError, bin)
    if (snap.closed) throw classifyExit(snap.closed, snap.stderr, port)
    const detail = last && last !== summary ? `${summary}。${last}` : summary
    throw Object.assign(new Error(detail), { code: 'AGENT_TIMEOUT' })
  }

  async function start() {
    const token = generation
    if (!bin) throw Object.assign(new Error('未找到设计助手程序。请重新构建桌面版。'), { code: 'AGENT_BIN' })
    const proc = spawn(bin, ['serve', '--bind', `127.0.0.1:${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child = proc
    let stderr = ''
    let spawnError = null
    let closed = null
    proc.on('error', error => { if (!spawnError) spawnError = error })
    proc.stdout?.on('error', () => {})
    proc.stderr?.on('error', () => {})
    proc.stdout?.resume()
    proc.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-800) })
    proc.on('close', (code, signal) => {
      closed = { code, signal }
      if (child === proc) {
        child = null
        if (base) base = ''
      }
    })
    try {
      await waitUntilReady(() => ({ spawnError, closed, stderr }))
      if (token !== generation) throw Object.assign(new Error('设计助手已关闭'), { code: 'AGENT_EXIT' })
      base = root()
      await restore().catch(() => {})
      if (token !== generation) throw Object.assign(new Error('设计助手已关闭'), { code: 'AGENT_EXIT' })
      return base
    } catch (error) {
      if (child === proc) child = null
      base = ''
      stop(proc)
      throw error
    }
  }

  async function ensure() {
    if (base) return base
    if (!starting) starting = start().finally(() => { starting = null })
    return starting
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
        const rows = providers.providers || []
        const active = rows.find(item => item.active)
        const mode = providers.mode || (active?.kind === 'local' ? 'local' : active ? 'configured' : 'unavailable')
        const label = providers.label || (mode === 'local' ? '本机模式' : active?.name || '')
        return { status: 'ok', providers: rows, mode, label, ccswitch }
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
    dispose() {
      generation += 1
      const proc = child
      child = null
      base = ''
      stop(proc)
    },
  }
}
