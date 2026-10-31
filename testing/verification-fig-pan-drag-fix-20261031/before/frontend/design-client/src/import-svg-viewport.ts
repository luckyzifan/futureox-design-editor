import type { Matrix } from './model'
import { svgNumberList } from './svg-values'

export type SvgViewBox = [number, number, number, number]

export function parseSvgViewBox(value: string | null): SvgViewBox | undefined {
  if (value === null) return undefined
  const numbers = svgNumberList(value, 'viewBox')
  if (numbers.length !== 4 || !numbers.every(Number.isFinite) || numbers[2] <= 0 || numbers[3] <= 0)
    throw new Error('SVG viewBox 必须包含四个有限数值和正尺寸；原文件未修改')
  return numbers as SvgViewBox
}

/** SVG 2 section 8.2: viewport alignment and meet/slice are geometry, not hints. */
export function svgViewportTransform(viewBox: SvgViewBox, width: number, height: number, value: string | null): Matrix {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('SVG 视口需要正的有限尺寸')
  const match = (value?.trim() || 'xMidYMid meet')
    .match(/^(none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(meet|slice))?$/)
  if (!match) throw new Error('SVG preserveAspectRatio 无法无损解析；原文件未修改')
  const [x, y, w, h] = viewBox, align = match[1], mode = match[2] || 'meet'
  let sx = width / w, sy = height / h
  if (align !== 'none') sx = sy = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
  const ax = align.includes('xMax') ? 1 : align.includes('xMid') ? 0.5 : 0
  const ay = align.includes('YMax') ? 1 : align.includes('YMid') ? 0.5 : 0
  return [sx, 0, 0, sy, (width - w * sx) * ax - x * sx, (height - h * sy) * ay - y * sy]
}
