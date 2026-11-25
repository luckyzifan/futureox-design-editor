const maxVideoBytes = 8 * 1024 * 1024
const maxPosterLength = 12 * 1024 * 1024
const webm = 'video/webm', mp4 = 'video/mp4'
const prefixes = [`data:${webm};base64,`, `data:${mp4};base64,`]
export const LOCAL_VIDEO_ACCEPT = 'video/webm,video/mp4,.webm,.mp4'

function container(bytes: Uint8Array) {
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return webm
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return mp4
  return undefined
}

export function isLocalVideoData(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const prefix = prefixes.find(prefix => value.startsWith(prefix))
  if (!prefix) return false
  const length = value.length - prefix.length
  if (length < 12 || length % 4 || length > Math.ceil(maxVideoBytes / 3) * 4) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  if (length / 4 * 3 - padding > maxVideoBytes) return false
  try {
    const header = Uint8Array.from(atob(value.slice(prefix.length, prefix.length + 12)), char => char.charCodeAt(0))
    return prefix === `data:${container(header)};base64,`
  } catch { return false }
}

export function localVideoObjectUrl(data: string) {
  if (!isLocalVideoData(data)) throw new Error('无效的本地视频填充')
  const comma = data.indexOf(',')
  const bytes = Uint8Array.from(atob(data.slice(comma + 1)), char => char.charCodeAt(0))
  if (bytes.length > maxVideoBytes) throw new Error('视频填充超过 8 MiB')
  return URL.createObjectURL(new Blob([bytes], { type: data.slice(5, comma - ';base64'.length) }))
}

export async function readLocalVideoFill(file: File, maxPixels: number, signal: AbortSignal) {
  if (!file.size || file.size > maxVideoBytes) throw new Error('请选择不超过 8 MiB 的 WebM 或 MP4')
  const original = await file.arrayBuffer()
  const mime = container(new Uint8Array(original, 0, Math.min(original.byteLength, 12)))
  if (!mime) throw new Error('请选择有效的 WebM 或 MP4 视频')
  signal.throwIfAborted()
  const blob = new Blob([original], { type: mime })
  const url = URL.createObjectURL(blob), video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      const finish = (error?: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        video.onloadeddata = null
        video.onerror = null
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('解码视频首帧超时')), 15000)
      signal.addEventListener('abort', abort, { once: true })
      video.onloadeddata = () => finish()
      video.onerror = () => finish(new Error('当前浏览器无法解码此视频'))
      video.src = url
    })
    const width = video.videoWidth, height = video.videoHeight
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > maxPixels ||
        !Number.isFinite(video.duration) || video.duration <= 0) throw new Error('视频尺寸或播放时长超出填充支持范围')
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法生成视频首帧')
    context.drawImage(video, 0, 0)
    const poster = canvas.toDataURL('image/png')
    if (!poster.startsWith('data:image/png;base64,') || poster.length > maxPosterLength)
      throw new Error('视频首帧超过 12 MiB 图片上限')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => isLocalVideoData(reader.result) ? resolve(reader.result) : reject(new Error('无效的视频原始数据'))
      reader.onerror = () => reject(reader.error ?? new Error('无法读取视频原始数据'))
      reader.readAsDataURL(blob)
    })
    signal.throwIfAborted()
    return { video: data, image: poster }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
