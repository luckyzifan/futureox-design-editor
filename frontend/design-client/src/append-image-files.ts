import { ImportStage, type ImportDiagnostic } from './import-diagnostics'
import { assertImportInputBytes } from './import-input-policy'
import type { Editor } from './engine'
import { node, paint, type Point } from './model'
import { screenToWorld, type CanvasSize } from './canvas-camera'
export type DecodedImportImage = { uri: string; width: number; height: number }
export class StaleImageImport extends Error { constructor() { super('图片导入期间画布已变化，请重新导入'); this.name = 'StaleImageImport' } }
export type DecodeImportImage = (file: File) => Promise<DecodedImportImage>
async function readImportImage(file: File, diagnostic?: ImportDiagnostic): Promise<DecodedImportImage> {
  diagnostic?.stage(ImportStage.read)
  const uri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error(`读取图片失败: ${file.name}`))
    reader.readAsDataURL(file)
  })
  diagnostic?.stage(ImportStage.decode)
  // Get image dimensions
  const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.width, height: img.height })
    img.onerror = () => reject(new Error(`解码图片失败: ${file.name}`))
    img.src = uri
  })

  return { uri, width: dims.width, height: dims.height }
}

/** Capture the actual visible canvas center before decoding. No fabricated viewport. */
export function captureImageImportAnchor(editor: Editor, size: CanvasSize): Point {
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0))
    throw new Error('画布尚未显示，请显示画布后再导入图片')
  const view = editor.flushPendingView()
  const anchor = screenToWorld(view, { x: size.width / 2, y: size.height / 2 })
  if (![anchor.x, anchor.y].every(Number.isFinite)) throw new Error('画布视图无效，请重试')
  return anchor
}

export async function appendImageFiles(editor: Editor, files: File[], anchor: Point, decode: DecodeImportImage = readImportImage, diagnose?: (file: File) => ImportDiagnostic) {
  if (![anchor.x, anchor.y].every(Number.isFinite)) throw new Error('图片导入位置无效')
  const intendedAnchor = { ...anchor }
  // Ownership fix: never rebase a deferred image onto another session/page/edit.
  const session = editor.sessionGeneration, document = editor.state.doc, page = editor.state.page, version = editor.state.version
  const assertCurrent = () => {
    if (editor.sessionGeneration !== session || editor.state.doc !== document || editor.state.page !== page ||
      editor.state.version !== version || editor.interactionActive || editor.state.busy) throw new StaleImageImport()
  }
  const diagnostics = files.map(file => diagnose?.(file))
  for (const diagnostic of diagnostics) diagnostic?.bindCancellation(() => {
    try { assertCurrent(); return false } catch { return true }
  })
  let activeIndex = -1
  try {
  assertCurrent()
  for (let index = 0; index < files.length; index++) {
    activeIndex = index
    const diagnostic = diagnostics[index]
    if (diagnostic) diagnostic.run(ImportStage.admission, () => assertImportInputBytes(files[index].size))
    else assertImportInputBytes(files[index].size)
  }
  const images: { uri: string; width: number; height: number }[] = []
  for (let index = 0; index < files.length; index++) {
    activeIndex = index
    const file = files[index], diagnostic = diagnostics[index]
    diagnostic?.stage(ImportStage.decode)
    const { uri, width, height } = await (decode === readImportImage ? readImportImage(file, diagnostic) : decode(file))
    assertCurrent()
    images.push({ uri, width, height })
  }

  assertCurrent()
  // Preserve the invocation-time intended center even if the user later pans.
  const centerX = intendedAnchor.x
  const centerY = intendedAnchor.y
  const spacing = 20
  const totalHeight = images.reduce((sum, image) => sum + image.height, 0) + Math.max(0, images.length - 1) * spacing
  let offsetY = centerY - totalHeight / 2

  activeIndex = -1
  for (const diagnostic of diagnostics) diagnostic?.stage(ImportStage.commit)
  const result = editor.change('导入图片', (doc) => {
    for (const { uri, width, height } of images) {
      // Construction fix: use all canonical required node/paint defaults.
      const imageNode = node('rectangle', centerX - width / 2, offsetY, width, height)
      imageNode.name = '图片'
      imageNode.fills = [{ ...paint('#ffffff'), kind: 'image', image: uri, fit: 'cover' }]
      doc.nodes[imageNode.id] = imageNode
      const currentPage = doc.pages.find(p => p.id === page)
      if (currentPage) currentPage.children.push(imageNode.id)
      offsetY += height + spacing
    }
  })
  if (result?.status === 'committed') editor.notify(`已导入 ${images.length} 张图片`)
  const status = result?.status ?? 'unchanged'
  for (const diagnostic of diagnostics) diagnostic?.result(status === 'committed' ? 1 : status === 'rejected' ? 3 : 2, status === 'committed' ? 1 : 0)
  return { count: images.length, status }
  } catch (error) {
    for (let index = 0; index < diagnostics.length; index++) {
      const sibling = activeIndex >= 0 && index !== activeIndex
      diagnostics[index]?.fail(sibling ? new DOMException('', 'AbortError') : error, sibling)
    }
    throw error
  }
}
