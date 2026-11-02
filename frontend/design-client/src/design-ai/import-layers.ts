import type { Editor } from '../engine'
import { node, paint, type Point } from '../model'
import { hasPendingEdits } from '../pending-edits'
import type { DesignAiResult } from './types'

/** Network replies may finish after editing, navigation, undo or document open. */
export function captureDesignAiOwner(editor: Editor) {
  const doc = editor.state.doc, page = editor.state.page, revision = editor.state.version, session = editor.sessionGeneration
  return () => {
    if (editor.state.doc !== doc || editor.state.page !== page || editor.state.version !== revision || editor.sessionGeneration !== session)
      throw new Error('生成期间画布已变化。结果已保留，可点击“添加到当前画布”。')
    if (editor.state.busy || editor.interactionActive || hasPendingEdits(editor))
      throw new Error('请先完成画布上的输入或操作，再添加生成结果。')
  }
}

export function selectedDesignAiImage(editor: Editor): string | undefined {
  if (editor.state.selection.length !== 1) return
  const selected = editor.state.doc.nodes[editor.state.selection[0]]
  if (!selected) return
  const images = selected.fills.filter(fill => fill.visible && fill.kind === 'image')
  return images.length === 1 && /^data:image\/(png|jpeg);base64,/.test(images[0].image || '') ? images[0].image : undefined
}

const decodeImage = (uri: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
  image.onerror = () => reject(new Error('生成图片无法解码，画布未改动。'))
  image.src = uri
})

export async function importDesignAiLayers(editor: Editor, result: DesignAiResult, anchor: Point,
  assertOwner = captureDesignAiOwner(editor), decode = decodeImage, title = 'AI 设计') {
  assertOwner()
  if (![anchor.x, anchor.y, result.width, result.height].every(Number.isFinite) || result.width <= 0 || result.height <= 0 ||
      !Array.isArray(result.layers) || !result.layers.length || result.layers.length > 17)
    throw new Error('生成结果的画板或图层信息无效。')
  const layers = [...result.layers].sort((a, b) => a.zIndex - b.zIndex)
  if (layers[0].zIndex !== 0 || new Set(layers.map(layer => layer.zIndex)).size !== layers.length)
    throw new Error('生成结果缺少底图或图层顺序无效。')
  for (const layer of layers) {
    if (!Number.isSafeInteger(layer.zIndex) || layer.zIndex < 0 || !/^data:image\/png;base64,/.test(layer.uri) ||
        ![layer.x, layer.y, layer.width, layer.height].every(Number.isFinite) || layer.x < 0 || layer.y < 0 ||
        layer.width <= 0 || layer.height <= 0 || layer.x + layer.width > result.width + 1e-8 || layer.y + layer.height > result.height + 1e-8)
      throw new Error('生成图层的位置或图片格式无效。')
    const image = await decode(layer.uri)
    assertOwner()
    if (image.width !== layer.imageWidth || image.height !== layer.imageHeight)
      throw new Error('生成图片尺寸与图层信息不一致，画布未改动。')
  }
  assertOwner()
  const pageId = editor.state.page
  const frame = node('frame', anchor.x - result.width / 2, anchor.y - result.height / 2, result.width, result.height)
  frame.name = title.slice(0, 200); frame.fills = []
  const authored = layers.map(layer => {
    const image = node('rectangle', layer.x, layer.y, layer.width, layer.height)
    image.name = layer.name
    // Ark explicitly specifies scaling the crop into this bounding rectangle.
    image.fills = [{ ...paint('#ffffff'), kind: 'image', image: layer.uri, fit: 'stretch' }]
    return image
  })
  frame.children = authored.map(image => image.id)
  const commit = editor.change('添加 AI 分层设计', doc => {
    const page = doc.pages.find(item => item.id === pageId)
    if (!page) throw new Error('目标页面已不存在。')
    for (const image of authored) doc.nodes[image.id] = image
    doc.nodes[frame.id] = frame
    page.children.push(frame.id)
  }, [frame.id])
  if (commit.status !== 'committed') throw new Error('生成结果未能通过文档校验，画布未改动。')
  editor.notify(`已添加 ${layers.length} 个 AI 图层，可继续编辑或撤销`)
  return { frameId: frame.id, count: layers.length }
}
