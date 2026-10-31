import { svgFraction } from './svg-values.ts'

type SvgAttributes = { getAttribute(name: string): string | null }
export type SvgStyle = Record<string, string>

const inheritedProperties = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'font-size', 'font-family', 'font-weight', 'text-anchor', 'visibility', 'color',
]

/** Presentation attributes inherit; opacity/display belong to one compositing node. */
export function svgPresentation(element: SvgAttributes, inherited: SvgStyle = {}) {
  const inline = Object.fromEntries((element.getAttribute('style') || '').split(';').flatMap(declaration => {
    const at = declaration.indexOf(':')
    if (at < 0) return []
    return [[declaration.slice(0, at).trim().toLowerCase(), declaration.slice(at + 1).trim()]]
  }))
  const style = { ...inherited }
  for (const property of inheritedProperties) {
    const value = inline[property] || element.getAttribute(property)
    if (value && value !== 'inherit') style[property] = value
  }
  return {
    style,
    inline,
    opacity: svgFraction(inline.opacity || element.getAttribute('opacity') || '1', 'opacity'),
    display: inline.display || element.getAttribute('display') || '',
  }
}

/** Resolve at the painted node so a descendant's color can override currentColor. */
export function svgPaintValue(value: string, style: SvgStyle) {
  return value === 'currentColor' ? style.color || '#000000' : value
}

export function svgRootPresentation(root: SvgAttributes) {
  const presentation = svgPresentation(root, { fill: '#000000' })
  for (const property of ['transform', 'filter', 'mask', 'clip-path', 'mix-blend-mode']) {
    const value = presentation.inline[property] || root.getAttribute(property)
    if (value && value !== 'none' && !(property === 'mix-blend-mode' && value === 'normal')) {
      throw new Error(`SVG 根元素 ${property} 暂不支持无损导入，请先展开；原文件未修改`)
    }
  }
  if (!Number.isFinite(presentation.opacity) || presentation.opacity < 0 || presentation.opacity > 1) {
    throw new Error('SVG 根元素 opacity 必须为 0–1')
  }
  return presentation
}

