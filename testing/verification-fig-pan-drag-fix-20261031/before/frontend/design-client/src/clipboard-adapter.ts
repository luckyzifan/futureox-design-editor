import { desktopBridge, type DesktopClipboard } from './desktop'

export const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024
export const MAX_CLIPBOARD_IMAGE_BYTES = 24 * 1024 * 1024
export const CLIPBOARD_TEXT_PREFIX = 'FORMA-NODES-V1\n'
export const CLIPBOARD_FORMA_TYPE = 'web application/x-forma-nodes-v1'
const nativePngType = 'web application/x-forma-png-v1'
const priority = [CLIPBOARD_FORMA_TYPE, 'application/x-forma-nodes-v1', nativePngType, 'image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'] as const

export function assertClipboardSize(value: string) {
  if (new TextEncoder().encode(value).byteLength > MAX_CLIPBOARD_BYTES) throw new Error('剪贴板内容超过 32 MiB')
}
function unsupported(error: unknown) { return error instanceof Error && error.name === 'NotSupportedError' }
async function imageDataUrl(blob: Blob, mime: string) {
  if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('剪贴板图像超过 24 MiB')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return `data:${mime};base64,${btoa(binary)}`
}

/** Read a single lossless representation. Never downgrade denied/invalid rich
 * content to text or an old in-memory copy. The document admission boundary
 * remains importClipboard/importSvg/image.decode in dispatchEditorCommand. */
export async function readEditorClipboard(): Promise<DesktopClipboard | null> {
  const native = desktopBridge()?.clipboard
  if (native) {
    const result = await native.read()
    if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '读取剪贴板已取消' : result.message)
    return result
  }
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard?.read) {
    let items: ClipboardItems
    try { items = await clipboard.read() }
    catch (error) { if (!unsupported(error)) throw error; return readTextOnly(clipboard) }
    if (items.length > 16) throw new Error('剪贴板项目过多')
    for (const mime of priority) {
      const item = items.find(item => item.types.includes(mime))
      if (!item) continue
      const blob = await item.getType(mime)
      if (blob.size > MAX_CLIPBOARD_BYTES) throw new Error('剪贴板内容超过 32 MiB')
      // A MIME declaration must agree with the Blob; custom web types carry
      // their underlying type, so the exact custom type need not match.
      if (!mime.startsWith('web ') && blob.type && blob.type !== mime) throw new Error('剪贴板 MIME 类型不一致')
      if (mime === nativePngType || ['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
        if (mime === nativePngType && blob.type && !['image/png', 'application/x-forma-png-v1', nativePngType].includes(blob.type)) throw new Error('剪贴板 MIME 类型不一致')
        return { image: await imageDataUrl(blob, mime === nativePngType ? 'image/png' : mime) }
      }
      const text = await blob.text(); assertClipboardSize(text)
      if (mime === 'image/svg+xml') return { svg: text }
      if (mime === 'text/plain') return { text }
      return { forma: text }
    }
    // An available clipboard with no supported types must not revive a prior
    // internal copy. This differs deliberately from an unavailable API (null).
    if (items.length) throw new Error('剪贴板没有支持的图层、SVG、图片或文字格式')
    return {}
  }
  return readTextOnly(clipboard)
}
async function readTextOnly(clipboard: Pick<Clipboard, 'readText'> | undefined): Promise<DesktopClipboard | null> {
  if (!clipboard?.readText) return null
  const text = await clipboard.readText(); assertClipboardSize(text)
  return { text }
}

/** Keep interoperable text packets on browsers without custom-format support.
 * A permission denial never causes a second clipboard API attempt. */
export async function writeWebGraphClipboard(forma: string) {
  assertClipboardSize(forma)
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  const text = CLIPBOARD_TEXT_PREFIX + forma
  assertClipboardSize(text)
  if (clipboard?.write && typeof ClipboardItem !== 'undefined' && ClipboardItem.supports?.(CLIPBOARD_FORMA_TYPE)) {
    try {
      await clipboard.write([new ClipboardItem({
        [CLIPBOARD_FORMA_TYPE]: new Blob([forma], { type: 'application/x-forma-nodes-v1' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })])
      return
    } catch (error) { if (!unsupported(error)) throw error }
  }
  if (!clipboard?.writeText) throw new Error('系统剪贴板不可用，原图层已保留')
  await clipboard.writeText(text)
}
