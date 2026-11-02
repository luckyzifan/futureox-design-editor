// Explicit, user-invoked image jobs. Credentials and provider transport stay in
// the host; authored layers and history remain owned by the existing Editor.
const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
export const SEEDREAM_MODELS = Object.freeze({
  pro: 'doubao-seedream-5-0-pro-260628',
  flash: 'doubao-seedream-5-0-flash-260915',
})
const MAX_IMAGE_BYTES = 30 * 1024 ** 2
const MAX_RESPONSE_BYTES = 96 * 1024 ** 2
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const fail = (code, message) => Object.assign(new Error(message), { code })
const invalid = message => fail('DESIGN_AI_INVALID', message)
const integer = value => Number.isSafeInteger(value) && value >= 0

function base64Bytes(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid('图片编码无效或超过 30 MiB。')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) throw invalid('图片编码无效或超过 30 MiB。')
  return bytes
}

function inputImage(value) {
  const match = typeof value === 'string' && /^data:image\/(png|jpeg);base64,(.*)$/.exec(value)
  if (!match) throw invalid('请选择已嵌入文档的 PNG 或 JPEG 原图。')
  const bytes = base64Bytes(match[2])
  if (match[1] === 'png' ? !bytes.subarray(0, 8).equals(PNG) : !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    throw invalid('参考图片格式与内容不一致。')
  return value
}

function dimensions(value) {
  const match = typeof value === 'string' && /^(\d+)x(\d+)$/.exec(value)
  const width = Number(match?.[1]), height = Number(match?.[2])
  if (!integer(width) || !integer(height) || !width || !height || width * height > 36_000_000)
    throw invalid('服务返回了无效的图片尺寸。')
  return { width, height }
}

/** Ark returns cropped PNGs: size is the asset size, bounding_box is placement
 * in the output background's coordinates. Never stretch every layer to canvas. */
export function normalizeSeedreamResult(response, decomposition) {
  if (!response || !Array.isArray(response.data) || !response.data.length || response.data.length > 17 ||
      (!decomposition && response.data.length !== 1) || response.data.some(item => !item || item.error))
    throw invalid('服务没有返回完整图片结果。')
  const items = response.data.map(item => ({ ...item, z_index: decomposition ? item.z_index : 0 }))
  if (items.some(item => !integer(item.z_index)) || new Set(items.map(item => item.z_index)).size !== items.length)
    throw invalid('服务返回的图层顺序无效。')
  items.sort((a, b) => a.z_index - b.z_index)
  if (items[0].z_index !== 0) throw invalid('分层结果缺少底图。')
  const canvas = dimensions(items[0].size)
  let totalBytes = 0
  const layers = items.map(item => {
    const asset = dimensions(item.size), bytes = base64Bytes(item.b64_json)
    totalBytes += bytes.length
    if (totalBytes > 64 * 1024 ** 2) throw invalid('本次生成的图片总量超过 64 MiB，请降低生成分辨率。')
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG) || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        bytes.readUInt32BE(16) !== asset.width || bytes.readUInt32BE(20) !== asset.height)
      throw invalid('服务返回的 PNG 内容与尺寸不一致。')
    let box = [0, 0, canvas.width, canvas.height]
    if (item.z_index > 0) {
      const absolute = item.bounding_box?.absolute, normalized = item.bounding_box?.normalized
      if (absolute !== undefined) box = absolute
      else if (Array.isArray(normalized) && normalized.length === 4 && normalized.every(v => integer(v) && v <= 1000))
        box = normalized.map((v, i) => v / 1000 * (i % 2 ? canvas.height : canvas.width))
      else throw invalid('分层结果缺少有效位置坐标。')
    }
    if (!Array.isArray(box) || box.length !== 4 || !box.every(v => Number.isFinite(v) && v >= 0) ||
        box[2] <= box[0] || box[3] <= box[1] || box[2] > canvas.width || box[3] > canvas.height)
      throw invalid('分层结果的位置超出画板。')
    return {
      name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 200) : item.z_index ? `图层 ${item.z_index}` : '底图',
      zIndex: item.z_index, x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1],
      imageWidth: asset.width, imageHeight: asset.height, uri: `data:image/png;base64,${item.b64_json}`,
    }
  })
  return { ...canvas, layers }
}

async function readJson(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw invalid('图片服务返回了空响应。')
  const chunks = []; let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw invalid('本次生成结果过大，请降低生成分辨率。')
      chunks.push(Buffer.from(next.value))
    }
    signal.throwIfAborted()
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw invalid('图片服务返回了无效响应。') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createDesignAiHost({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 180_000 } = {}) {
  let sessionKey = '', active = null
  const key = () => sessionKey || env.ARK_API_KEY || ''
  const errorResult = error => ({ status: 'error', code: error.code || 'DESIGN_AI_NETWORK',
    message: error.code?.startsWith('DESIGN_AI_') ? error.message : '无法连接图片服务，请检查网络后重试。' })
  return {
    status() { return { status: 'ok', configured: !!key(), busy: !!active, models: SEEDREAM_MODELS } },
    configure(value) {
      if (active) return errorResult(fail('DESIGN_AI_BUSY', '请先等待或取消当前生成。'))
      if (!value || typeof value.apiKey !== 'string' || value.apiKey.length > 512 || /\s/.test(value.apiKey))
        return errorResult(invalid('请输入有效的火山方舟 API Key。'))
      sessionKey = value.apiKey
      return this.status()
    },
    cancel(value) {
      if (active && active.id === value?.requestId) active.controller.abort()
      return { status: 'ok' }
    },
    dispose() { active?.controller.abort(); sessionKey = '' },
    async run(value) {
      if (active) return errorResult(fail('DESIGN_AI_BUSY', '已有图片任务正在进行。'))
      let job, timer
      try {
        if (!key()) throw fail('DESIGN_AI_KEY', '请先连接火山方舟 API Key。')
        if (!value || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.requestId) ||
            !Object.hasOwn(SEEDREAM_MODELS, value.model) || !['generate', 'decompose'].includes(value.mode))
          throw invalid('图片任务参数无效。')
        const decomposition = value.mode === 'decompose'
        if (typeof value.prompt !== 'string' || value.prompt.length > 6000 || (!decomposition && !value.prompt.trim()))
          throw invalid('请填写设计描述（最多 6000 字符）。')
        if (!['1K', '1.5K', '2K'].includes(value.size)) throw invalid('请选择有效分辨率。')
        if (decomposition && !value.image) throw invalid('请先选择需要分层的图片。')
        const body = { model: SEEDREAM_MODELS[value.model], prompt: value.prompt,
          size: decomposition ? 'auto' : value.size, response_format: 'b64_json', output_format: 'png', watermark: true,
          ...(value.image ? { image: inputImage(value.image) } : {}),
          ...(decomposition ? { layer_decomposition: true } : {}),
        }
        job = { id: value.requestId, controller: new AbortController() }; active = job
        timer = setTimeout(() => job.controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs)
        const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: {
          Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json',
        }, body: JSON.stringify(body), signal: job.controller.signal, redirect: 'error' })
        if (!response.ok) {
          await response.body?.cancel()
          const message = [401, 403].includes(response.status) ? 'API Key 无效或尚未开通该模型。' :
            response.status === 429 ? '图片服务额度或并发已达上限，请稍后重试。' :
            response.status === 400 ? '图片服务拒绝了请求，请检查提示词、原图尺寸和模型权限。' : '图片服务暂时不可用，请稍后重试。'
          throw fail('DESIGN_AI_PROVIDER', message)
        }
        const result = normalizeSeedreamResult(await readJson(response, job.controller.signal), decomposition)
        job.controller.signal.throwIfAborted()
        return { status: 'ok', result }
      } catch (error) {
        if (job?.controller.signal.aborted) return job.controller.signal.reason?.name === 'TimeoutError'
          ? errorResult(fail('DESIGN_AI_TIMEOUT', '图片生成超时，服务端任务可能仍在运行；请确认后再重试。')) : { status: 'cancelled' }
        return errorResult(error)
      } finally { clearTimeout(timer); if (job && active === job) active = null }
    },
  }
}
