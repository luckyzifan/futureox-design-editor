import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { record } from './security.mjs'

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const positive = value => Number.isSafeInteger(value) && value > 0
const failure = (message, code = 'CLOUD_SETTINGS') => Object.assign(new Error(message), { code })

function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw failure('云端请求标识无效')
  return value
}

export function cloudBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) throw failure('请输入协作服务地址')
  let url
  try { url = new URL(value.trim()) } catch { throw failure('协作服务地址无效') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const pathname = url.pathname.replace(/\/$/, '')
  if (url.username || url.password || (pathname && !/^(?:\/[A-Za-z0-9_-]+)+$/.test(pathname)) || url.search || url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')))
    throw failure('请输入 HTTPS 协作服务地址。本机测试可使用 HTTP 回环地址。')
  return url.origin + pathname
}

function credential(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(value)) throw failure('请输入工作区访问令牌')
  return value
}

function route(method, target) {
  if (method === 'GET' && target === '/documents') return target
  if (typeof target !== 'string' || target.length > 110) throw failure('云端请求路径无效')
  const parts = /^\/documents\/([^/?]+)(?:\/(versions|changes)(?:\/(\d+)|\?after=(\d+)))?$/.exec(target)
  if (!parts || !uuid.test(parts[1])) throw failure('云端请求路径无效')
  const [, , endpoint, version, after] = parts
  if (endpoint ? method !== 'GET' || (endpoint === 'versions'
      ? !version || !positive(Number(version)) : !after || !positive(Number(after)))
    : !['GET', 'PUT', 'PATCH'].includes(method))
    throw failure('云端请求方法无效')
  return target
}

function checkpoint(input) {
  const value = record(input, ['revision', 'pending', 'applying'])
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw failure('云端版本记录无效')
  const result = { revision: value.revision }
  if (value.pending !== undefined) {
    const pending = record(value.pending, ['localRevision', 'requestId'])
    if (!positive(pending.localRevision)) throw failure('本机版本记录无效')
    result.pending = { localRevision: pending.localRevision, requestId: identifier(pending.requestId) }
  }
  if (value.applying !== undefined) {
    const applying = record(value.applying, ['revision', 'mutationId'])
    if (!positive(applying.revision) || applying.revision < value.revision)
      throw failure('云端接收记录无效')
    result.applying = { revision: applying.revision, mutationId: identifier(applying.mutationId) }
  }
  return result
}

async function readJson(filename, limit) {
  let handle
  try {
    handle = await open(filename, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw failure('云端配置文件无效')
    const bytes = await handle.readFile()
    if (bytes.length > limit) throw failure('云端配置文件无效')
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  } finally { await handle?.close() }
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { mode: 0o700, recursive: true })
  const temporary = filename + '.' + randomUUID() + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, filename)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

async function readResponse(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw failure('云端文档超过本机接收容量', 'CLOUD_CAPACITY')
  }
  if (!response.body) throw failure('云端响应为空', 'CLOUD_RESPONSE')
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw failure('云端文档超过本机接收容量', 'CLOUD_CAPACITY')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
}

/** Cloud authorization lives in the main process. The renderer can use the
 * configured workspace API through a revocable handle. */
export function createCloudCollaboration({ root, safeStorage, documentLimit, findLocalMutation,
  fetchImpl = globalThis.fetch, platform = process.platform }) {
  const directory = () => path.join(root(), 'collaboration-v1')
  const settingsFile = () => path.join(directory(), 'settings.json')
  const cursorFile = (connection, id) => path.join(directory(), connection.scope, identifier(id) + '.json')
  const calls = new Map()
  let settings, connection, loading, tail = Promise.resolve()

  function queue(work) {
    const task = tail.then(work, work)
    tail = task.then(() => {}, () => {})
    return task
  }

  function canRemember() {
    return safeStorage.isEncryptionAvailable() &&
      (platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
  }

  function activate(baseUrl, token) {
    for (const call of calls.values()) call.abort()
    calls.clear()
    connection = token ? { handle: randomUUID(), baseUrl, token,
      scope: createHash('sha256').update(baseUrl).update('\0').update(token).digest('hex') } : undefined
  }

  function decrypt(value) {
    if (!value?.secret || !canRemember()) return undefined
    try { return credential(safeStorage.decryptString(Buffer.from(value.secret, 'base64'))) }
    catch { return undefined }
  }

  async function initialize() {
    if (settings) return
    loading ??= (async () => {
      const stored = await readJson(settingsFile(), 16 * 1024)
      if (!stored) { settings = { enabled: false }; return }
      if (stored.version !== 1 || typeof stored.enabled !== 'boolean') throw failure('云端设置文件无效')
      settings = { enabled: stored.enabled, baseUrl: stored.baseUrl ? cloudBaseUrl(stored.baseUrl) : undefined,
        secret: typeof stored.secret === 'string' ? stored.secret : undefined }
      if (settings.enabled && settings.baseUrl) activate(settings.baseUrl, decrypt(settings))
    })().finally(() => { loading = undefined })
    await loading
  }

  function status() {
    return { status: 'ok', enabled: settings.enabled, baseUrl: settings.baseUrl,
      handle: connection?.handle, remembersToken: !!settings.secret }
  }

  function authorize(handle) {
    if (!connection || handle !== connection.handle) throw failure('云端协作连接已关闭', 'CLOUD_DISABLED')
    return connection
  }

  async function send(owner, method, target, body, signal) {
    let response
    try {
      response = await fetchImpl(owner.baseUrl + '/api/design' + route(method, target), {
        method, body, signal, redirect: 'error', cache: 'no-store',
        headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' },
      })
    } catch { throw failure('协作服务暂时不可达，本机编辑可继续', 'CLOUD_NETWORK') }
    if (!response.ok) {
      const error = await readResponse(response, 64 * 1024).catch(() => undefined)
      return { status: 'ok', httpStatus: response.status,
        data: { error: typeof error?.error === 'string' ? error.error.slice(0, 400) : 'HTTP ' + response.status } }
    }
    try {
      return { status: 'ok', httpStatus: response.status, data: await readResponse(response, documentLimit + 256 * 1024) }
    } catch (error) {
      if (signal.aborted) throw failure('云端响应超时，本机编辑可继续', 'CLOUD_NETWORK')
      if (error.code) throw error
      throw failure('云端返回了无效数据', 'CLOUD_RESPONSE')
    }
  }

  return {
    async status() { await initialize(); return status() },
    configure(input) {
      return queue(async () => {
        await initialize()
        const value = record(input, ['enabled', 'baseUrl', 'token'])
        if (typeof value.enabled !== 'boolean') throw failure('云端设置无效')
        if (!value.enabled) {
          const next = { ...settings, enabled: false }
          await writeJson(settingsFile(), { version: 1, ...next })
          settings = next
          activate(undefined, undefined)
          return status()
        }
        const baseUrl = cloudBaseUrl(value.baseUrl)
        const token = value.token?.trim() ? credential(value.token.trim())
          : baseUrl === settings.baseUrl ? (connection?.token ?? decrypt(settings)) : undefined
        if (!token) throw failure('请输入工作区访问令牌')
        const probe = await send({ baseUrl, token }, 'GET', '/documents', undefined, AbortSignal.timeout(15000))
        if (probe.httpStatus !== 200 || !Array.isArray(probe.data))
          throw failure(probe.httpStatus === 401 ? '工作区访问令牌无效' : '协作服务连接失败')
        const secret = canRemember() ? safeStorage.encryptString(token).toString('base64') : undefined
        const next = { enabled: true, baseUrl, secret }
        await writeJson(settingsFile(), { version: 1, ...next })
        settings = next
        activate(baseUrl, token)
        return status()
      })
    },
    async request(input) {
      const value = record(input, ['handle', 'callId', 'method', 'target', 'body'])
      const owner = authorize(value.handle), callId = identifier(value.callId)
      const target = route(value.method, value.target)
      if (value.method === 'GET' ? value.body !== undefined :
          typeof value.body !== 'string' || Buffer.byteLength(value.body) > documentLimit + 4096)
        throw failure('云端请求内容超限或无效', 'CLOUD_CAPACITY')
      if (calls.has(callId) || calls.size >= 8) throw failure('云端请求繁忙，请稍后重试', 'CLOUD_NETWORK')
      const controller = new AbortController()
      calls.set(callId, controller)
      try {
        const result = await send(owner, value.method, target, value.body,
          AbortSignal.any([controller.signal, AbortSignal.timeout(value.method === 'GET' ? 20000 : 45000)]))
        authorize(value.handle)
        return result
      } finally { calls.delete(callId) }
    },
    cancel(input) {
      const value = record(input, ['handle', 'callId'])
      if (value.handle === connection?.handle) calls.get(identifier(value.callId))?.abort()
      return { status: 'ok' }
    },
    readCursor(input) {
      return queue(async () => {
        await initialize()
        const value = record(input, ['handle', 'id'])
        const filename = cursorFile(authorize(value.handle), value.id)
        const stored = await readJson(filename, 2048)
        if (!stored) return { status: 'ok', cursor: null }
        let cursor = checkpoint(stored)
        if (cursor.applying && await findLocalMutation(value.id, cursor.applying.mutationId)) {
          cursor = { revision: cursor.applying.revision }
          await writeJson(filename, cursor)
        }
        return { status: 'ok', cursor }
      })
    },
    writeCursor(input) {
      return queue(async () => {
        await initialize()
        const value = record(input, ['handle', 'id', 'cursor'])
        const filename = cursorFile(authorize(value.handle), value.id)
        await writeJson(filename, checkpoint(value.cursor))
        return { status: 'ok' }
      })
    },
  }
}
