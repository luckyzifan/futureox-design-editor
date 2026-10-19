import { identity, paint, type Matrix, type Paint } from './model'
import { multiply } from './geometry'
import { svgAbsoluteLength, svgFraction } from './svg-values'
import { svgPresentation } from './svg-presentation'

type Template = { attributes: Map<string, string>; stops: Element[]; parsedStops?: Paint['stops']; matrix?: Matrix }
const attributes = ['gradientUnits', 'gradientTransform', 'spreadMethod', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy', 'fr']
const isGradient = (element: Element) => ['linearGradient', 'radialGradient'].includes(element.localName)

/** Resolve local template chains once per import, never external resources. */
export function svgGradientParser(xml: Document, color: (value: string) => string, transform: (value: string) => Matrix) {
  const cache = new Map<Element, Template>()
  const resolve = (element: Element): Template => {
    const cached = cache.get(element)
    if (cached) return cached
    // This inherited property follows the defining XML tree, not the painted
    // shape or the href template's attribute fallback chain.
    let ancestor: Element | null = element
    while (ancestor) {
      const inline = svgPresentation(ancestor).inline
      const interpolation = inline['color-interpolation'] || ancestor.getAttribute('color-interpolation')
      if (interpolation && interpolation !== 'inherit') {
        if (!['sRGB', 'auto'].includes(interpolation)) throw new Error('SVG 渐变 color-interpolation 暂不能无损导入；原文件未修改')
        break
      }
      ancestor = ancestor.parentElement
    }
    const chain: Element[] = [], seen = new Set<Element>()
    let at: Element | null = element
    while (at) {
      if (!isGradient(at)) throw new Error(`不支持的 SVG 渐变模板 ${at.localName}`)
      if (seen.has(at)) throw new Error('SVG 渐变模板循环引用')
      if (chain.length >= 64) throw new Error('SVG 渐变模板超过 64 层')
      seen.add(at)
      chain.push(at)
      const href = at.getAttribute('href') ?? at.getAttribute('xlink:href')
      if (href === null) break
      if (!/^#[^\s#]+$/.test(href)) throw new Error('SVG 渐变外部引用不能导入')
      at = xml.getElementById(href.slice(1))
      if (!at) throw new Error(`缺少 SVG 渐变模板 ${href}`)
    }
    const result: Template = { attributes: new Map(), stops: [] }
    for (const item of chain) {
      const inline = svgPresentation(item).inline
      if (inline.transform || inline['transform-origin']) throw new Error('SVG 渐变 CSS 变换暂不能无损导入；请使用 gradientTransform')
      for (const key of attributes) if (!result.attributes.has(key) && item.hasAttribute(key)) result.attributes.set(key, item.getAttribute(key)!)
      if (!result.stops.length) {
        const content = Array.from(item.children).filter(child => !['title', 'desc', 'metadata'].includes(child.localName))
        if (content.some(child => child.localName !== 'stop')) throw new Error('SVG 渐变包含尚不支持的动态或非色标内容')
        if (content.length > 32) throw new Error('SVG 渐变超过 32 个色标；不能无损缩减')
        result.stops = content
      }
    }
    cache.set(element, result)
    return result
  }
  return (element: Element, size: { width: number; height: number }, box: { x: number; y: number }, viewport: { width: number; height: number }, opacity: number): Paint => {
    if (!isGradient(element)) throw new Error(`不支持的 SVG 填充 ${element.localName}`)
    const template = resolve(element), radial = element.localName === 'radialGradient'
    const attr = (key: string, fallback: string) => template.attributes.get(key) ?? fallback
    const units = attr('gradientUnits', 'objectBoundingBox')
    if (!['objectBoundingBox', 'userSpaceOnUse'].includes(units)) throw new Error(`不支持的 SVG 渐变坐标单位 ${units}`)
    if (attr('spreadMethod', 'pad') !== 'pad') throw new Error('SVG 重复或镜像渐变暂不能无损导入；原文件未修改')
    const gradientMatrix = template.matrix ??= transform(attr('gradientTransform', ''))
    const user = units === 'userSpaceOnUse'
    const coordinate = (value: string, axis: 'x' | 'y' | 'r') => {
      const source = value.trim()
      if (!user) return svgFraction(source, '渐变坐标')
      if (!source.endsWith('%')) return svgAbsoluteLength(source, '渐变坐标')
      const reference = axis === 'x' ? viewport.width : axis === 'y' ? viewport.height : Math.hypot(viewport.width, viewport.height) / Math.SQRT2
      return svgFraction(source, '渐变坐标') * reference
    }
    if (!template.parsedStops) {
      let previousOffset = 0
      template.parsedStops = template.stops.map(stop => {
        const inline = svgPresentation(stop).inline
        if (svgFraction(inline['stop-opacity'] || stop.getAttribute('stop-opacity') || '1', 'stop-opacity') !== 1)
          throw new Error('当前 SVG 导入不支持独立色标透明度')
        const offset = Math.max(previousOffset, Math.min(1, Math.max(0, svgFraction(stop.getAttribute('offset') || '0', '渐变 offset'))))
        previousOffset = offset
        const value = inline['stop-color'] || stop.getAttribute('stop-color') || '#000000'
        if (value === 'currentColor') throw new Error('SVG 渐变色标 currentColor 暂不能无损导入；请提供明确颜色')
        return { offset, color: color(value) }
      })
      if (!template.parsedStops.length) throw new Error('SVG 渐变没有色标')
      if (template.parsedStops.length === 1) template.parsedStops.push({ ...template.parsedStops[0], offset: 1 })
    }
    // Never share mutable stops between independently editable layer paints.
    const stops = template.parsedStops.map(stop => ({ ...stop }))
    let basis: Matrix
    if (radial) {
      const cx = coordinate(attr('cx', '50%'), 'x'), cy = coordinate(attr('cy', '50%'), 'y'), r = coordinate(attr('r', '50%'), 'r')
      const fx = coordinate(attr('fx', attr('cx', '50%')), 'x'), fy = coordinate(attr('fy', attr('cy', '50%')), 'y')
      if (fx !== cx || fy !== cy || coordinate(attr('fr', '0'), 'r') !== 0) throw new Error('当前 SVG 导入不支持偏心或非零焦点半径的径向渐变')
      if (r < 0) throw new Error('SVG 径向渐变半径不能为负数')
      if (r === 0) return { ...paint(stops.at(-1)!.color), opacity }
      basis = [2 * r, 0, 0, 2 * r, cx - r, cy - r]
    } else {
      const x = coordinate(attr('x1', '0%'), 'x'), y = coordinate(attr('y1', '0%'), 'y')
      const dx = coordinate(attr('x2', '100%'), 'x') - x, dy = coordinate(attr('y2', '0%'), 'y') - y
      if (dx === 0 && dy === 0) return { ...paint(stops.at(-1)!.color), opacity }
      basis = [dx, dy, -dy, dx, x, y]
    }
    if (size.width <= 0 || size.height <= 0) throw new Error('SVG 渐变需要非零图形边界')
    const normalize: Matrix = user ? [1 / size.width, 0, 0, 1 / size.height, -box.x / size.width, -box.y / size.height] : identity()
    // Preserve the whole affine basis. Reconstructing a perpendicular after
    // gradientTransform would change sheared/nonuniformly scaled gradients.
    const matrix = multiply(multiply(normalize, gradientMatrix), basis)
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2]
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
      throw new Error('SVG 渐变变换无效或超出可编辑精度范围；原文件未修改')
    return { ...paint(stops[0].color, radial ? 'radial' : 'linear'), opacity, stops, transform: matrix }
  }
}
