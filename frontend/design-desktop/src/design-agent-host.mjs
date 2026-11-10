// Electron-side client for the Tokio design-agent. The binary serves loopback
// HTTP; this module is the only process that stores provider secrets on disk.
// The kernel chooses the active connection. This process persists that choice
// with the remaining secrets, and does not report success when the write fails.
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const fail = (error, code = error?.code || 'AGENT') => ({ status: 'error', code, message: error?.message || '设计助手不可用' })

export function createDesignAgentHost({ bin, port = 3927, storePath, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  let child = null
  let base = ''
  let starting = null
  let tail = Promise.resolve()
  const root = () => `http://127.0.0.1:${port}`
  const store = () => typeof storePath === 'function' ? storePath() : storePath
  const enqueue = task => {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  async function waitUntilReady(proc, spawnFailure) {
    const deadline = Date.now() + 8000
    let last = '设计助手没有在 8 秒内就绪'
    while (Date.now() < deadline) {
      // Node reports spawn failures (missing binary, EACCES) asynchronously as
      // an 'error' event; without a listener it stays an unhandled event that
      // kills the host. Keep it bounded and surface it as a startup failure.
      const failure = spawnFailure?.()
      if (failure) throw Object.assign(new Error(`设计助手进程启动失败：${failure.message}`), { code: 'AGENT_SPAWN' })
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
      let spawnError = null
      child.on('error', error => { spawnError = error })
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-500) })
      try { await waitUntilReady(child, () => spawnError) }
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
    if (saved.active) {
      const row = saved.providers.find(item => item?.id === saved.active)
      const body = { id: saved.active }
      if (row?.profile_id) body.profile_id = row.profile_id
      await postDirect('/v1/providers/activate', body).catch(() => {})
    }
  }

  async function readSaved(file) {
    const raw = await readFile(file, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return ''
      throw error
    })
    if (!raw) return { providers: [], active: '' }
    let parsed
    try { parsed = JSON.parse(raw) }
    catch { throw Object.assign(new Error('本机连接配置已损坏，没有继续更改。'), { code: 'AGENT_STORE' }) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('本机连接配置已损坏，没有继续更改。'), { code: 'AGENT_STORE' })
    }
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      active: typeof parsed.active === 'string' ? parsed.active : '',
    }
  }

  async function writeSaved(file, saved) {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
    await writeFile(temporary, JSON.stringify({ providers: saved.providers, active: saved.active }))
    try { await rename(temporary, file) }
    catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async function replay(saved) {
    for (const provider of saved.providers) await postDirect('/v1/providers', provider)
    if (!saved.active) return
    const row = saved.providers.find(item => item?.id === saved.active)
    const body = { id: saved.active }
    if (row?.profile_id) body.profile_id = row.profile_id
    await postDirect('/v1/providers/activate', body)
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
      return enqueue(async () => {
        try {
          await request('POST', '/v1/providers', value)
          const file = store()
          if (file) {
            const saved = await readSaved(file)
            const providers = saved.providers.filter(item => item?.id !== value?.id)
            providers.push(value)
            await writeSaved(file, { providers, active: value.id })
          }
          return { status: 'ok' }
        } catch (error) { return fail(error) }
      })
    },
    async activate(value) {
      return enqueue(async () => {
        try {
          await request('POST', '/v1/providers/activate', value)
          const file = store()
          if (file && value?.id) {
            const saved = await readSaved(file)
            const providers = saved.providers
            if (value.profile_id) {
              const row = providers.find(item => item?.id === value.id)
              if (row) row.profile_id = value.profile_id
              else providers.push({ id: value.id, name: 'CC Switch', kind: 'ccswitch', base_url: 'http://127.0.0.1:15721/v1', model: '', secret: '', wire: 'openai_chat', profile_id: value.profile_id })
            }
            await writeSaved(file, { providers, active: value.id })
          }
          return { status: 'ok' }
        } catch (error) { return fail(error) }
      })
    },
    async remove(value) {
      return enqueue(async () => {
        const file = store()
        try {
          const saved = file ? await readSaved(file) : null
          const payload = await request('POST', '/v1/providers/remove', value)
          if (!file) return { status: 'ok' }
          const id = typeof value?.id === 'string' ? value.id : ''
          let active = typeof payload?.active === 'string' ? payload.active : ''
          if (!active || active === id) {
            const listed = await request('GET', '/v1/providers')
            active = (listed.providers || []).find(item => item.active)?.id || ''
          }
          if (!active || active === id) active = 'local'
          const providers = saved.providers.filter(item => item?.id !== id)
          try {
            await writeSaved(file, { providers, active })
          } catch (writeError) {
            const stored = saved.providers.some(item => item?.id === id)
            try {
              await replay(saved)
              if (stored) {
                const listed = await request('GET', '/v1/providers')
                if (!(listed.providers || []).some(item => item.id === id)) {
                  return fail(Object.assign(new Error(`连接没有删除：本机配置写入失败（${writeError.message}），内存也未能恢复。`), { code: 'AGENT_STORE' }))
                }
              }
            } catch (rollbackError) {
              return fail(Object.assign(new Error(`连接没有删除：本机配置写入失败（${writeError.message}），内存也未能恢复（${rollbackError.message}）。`), { code: 'AGENT_STORE' }))
            }
            const kept = stored ? '原连接仍在。' : '这条连接原先不在配置文件里，当前进程里的副本未能保留。'
            return fail(Object.assign(new Error(`连接没有删除：本机配置写入失败（${writeError.message}）。${kept}`), { code: 'AGENT_STORE' }))
          }
          return { status: 'ok' }
        } catch (error) { return fail(error) }
      })
    },
    async cancel(value) {
      try { await request('POST', '/v1/cancel', value); return { status: 'ok' } }
      catch (error) { return fail(error) }
    },
    dispose() { child?.kill(); child = null; base = ''; starting = null },
  }
}
