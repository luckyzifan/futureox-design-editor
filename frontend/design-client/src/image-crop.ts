import { inverse, multiply, translate } from './geometry'
import type { Bounds, Matrix, Paint } from './model'

/**
 * Image crop math for the crop tool. The kernel maps image UV space through
 * `paint.transform` into the node's unit square (paint.rs ImageCoordinates
 * samples with the inverse of the authored transform), so
 * `uv_node = transform · uv_image`; when no transform is authored, `fit`
 * defines an implicit affine mapping that depends on the image's natural
 * size. Cropping rewrites both the node frame and the fill transform so the
 * displayed pixels stay exactly stationary — only the visible window moves.
 */

/** Image-UV → normalized node-space (0..1) transform of an image fill. */
export function imageUvTransform(
  fill: Pick<Paint, 'transform' | 'fit'>,
  width: number,
  height: number,
  natural?: { width: number; height: number },
): Matrix {
  if (fill.transform) return fill.transform
  if (fill.fit === 'stretch') return [1, 0, 0, 1, 0, 0]
  if (!natural || !(natural.width > 0) || !(natural.height > 0))
    throw new Error('需要图片原始尺寸来计算裁切映射')
  const iw = natural.width, ih = natural.height
  const ratio = fill.fit === 'contain' ? Math.min(width / iw, height / ih) : Math.max(width / iw, height / ih)
  return [
    (ratio * iw) / width,
    0,
    0,
    (ratio * ih) / height,
    (width - iw * ratio) / (2 * width),
    (height - ih * ratio) / (2 * height),
  ]
}

export type CropResult = {
  /** Replacement node transform; the crop origin becomes the new origin. */
  transform: Matrix
  width: number
  height: number
  /** Fill transform that keeps the cropped window's pixels in place. */
  fillTransform: Matrix
}

/** Crop a node with an image fill to `rect`, given in node-local units. */
export function cropImageNode(
  node: { width: number; height: number; transform: Matrix },
  fill: Pick<Paint, 'transform' | 'fit'>,
  rect: Bounds,
  natural?: { width: number; height: number },
): CropResult {
  const inside =
    Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
    rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
    rect.x + rect.width <= node.width + 1e-9 && rect.y + rect.height <= node.height + 1e-9
  if (!inside) throw new Error('裁切区域必须位于图层内部')
  const uv = imageUvTransform(fill, node.width, node.height, natural)
  // Old normalized coordinate of a point in the new (cropped) node frame.
  const window: Matrix = [
    rect.width / node.width,
    0,
    0,
    rect.height / node.height,
    rect.x / node.width,
    rect.y / node.height,
  ]
  return {
    transform: multiply(node.transform, translate(rect.x, rect.y)),
    width: rect.width,
    height: rect.height,
    fillTransform: multiply(inverse(window), uv),
  }
}

/** Decode the natural pixel size of a stored data-URL image fill. */
export async function imageNaturalSize(data: string): Promise<{ width: number; height: number }> {
  const image = new Image()
  image.src = data
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取图片尺寸')
  return { width: image.naturalWidth, height: image.naturalHeight }
}
