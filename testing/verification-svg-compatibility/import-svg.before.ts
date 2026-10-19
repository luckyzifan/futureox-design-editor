import {
  blank,
  node,
  paint,
  stroke,
  identity,
  defaultTextStyle,
  type DesignDocument,
  type DesignNode,
  type Matrix,
  type Paint,
} from './model'
import { multiply, translate, rotate, apply } from './geometry'
import { kernelBounds } from './kernel/picking'
import { svgPaintValue, svgPresentation, svgRootPresentation } from './svg-presentation'
import { parseSvgViewBox, svgViewportTransform } from './import-svg-viewport'
import { pathNetwork } from './path-network'
export { pathNetwork } from './path-network'
export type ImportedDesign = { document: DesignDocument; warnings: string[] }
export function svgTransform(value: string): Matrix {
  let result = identity(),
    end = 0
  for (const match of value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    if (value.slice(end, match.index).replace(/[\s,]/g, '')) throw new Error('SVG 变换语法无效')
    end = match.index! + match[0].length
    const a = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (a.some((x) => !Number.isFinite(x))) throw new Error('SVG 变换数值无效')
    let m: Matrix
    switch (match[1]) {
      case 'matrix':
        if (a.length !== 6) throw new Error('SVG matrix 需要六个参数')
        m = a as Matrix
        break
      case 'translate':
        m = translate(a[0], a[1] || 0)
        break
      case 'scale':
        m = [a[0], 0, 0, a[1] ?? a[0], 0, 0]
        break
      case 'rotate':
        m = multiply(
          multiply(translate(a[1] || 0, a[2] || 0), rotate((a[0] * Math.PI) / 180)),
          translate(-(a[1] || 0), -(a[2] || 0)),
        )
        break
      case 'skewX':
        m = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]
        break
      case 'skewY':
        m = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0]
        break
      default:
        throw new Error(`不支持的 SVG 变换 ${match[1]}`)
    }
    result = multiply(result, m)
  }
  if (value.slice(end).trim()) throw new Error('SVG 变换语法无效')
  return result
}
export function importSvg(source: string, name = '导入 SVG'): ImportedDesign {
  if (source.length > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('SVG 大小或声明不受支持')
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml'),
    root = xml.documentElement
  if (root.localName !== 'svg' || xml.querySelector('parsererror')) throw new Error('SVG XML 无效')
  if (Array.from(root.attributes).some((attribute) => /^on/i.test(attribute.name)))
    throw new Error('SVG 事件脚本不能导入')
  const rootPresentation = svgRootPresentation(root)
  const doc = blank(name),
    warnings = new Set<string>()
  let count = 0
  const length = (el: Element, key: string, fallback = 0) => {
    const s = el.getAttribute(key)
    if (!s) return fallback
    if (!/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:px)?$/i.test(s))
      throw new Error(`SVG ${key} 需要绝对像素长度`)
    return Number.parseFloat(s)
  }
  const color = (value: string) => {
    const canvas = document.createElement('canvas'),
      ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#010203'
    ctx.fillStyle = value
    const first = ctx.fillStyle
    ctx.fillStyle = '#030201'
    ctx.fillStyle = value
    if (ctx.fillStyle !== first) throw new Error(`不支持的 SVG 颜色 ${value}`)
    if (/^#[0-9a-f]{6}$/i.test(first)) return first
    const m = String(first).match(/^rgba?\(([^)]+)\)$/)
    if (m) {
      const parts = m[1].split(',').map(Number)
      if (parts[3] !== undefined && parts[3] !== 1)
        throw new Error('请使用 fill-opacity 表达透明颜色')
      return (
        '#' +
        parts
          .slice(0, 3)
          .map((v) => Math.round(v).toString(16).padStart(2, '0'))
          .join('')
      )
    }
    throw new Error(`不支持的 SVG 颜色 ${value}`)
  }
  const ref = (value: string) => {
    const m = value.match(/^url\(#([^\s)]+)\)$/)
    const e = m && xml.getElementById(m[1])
    if (!e) throw new Error(`缺少 SVG 引用 ${value}`)
    return e
  }
  const makePaint = (
    value: string,
    n: DesignNode,
    box: { x: number; y: number },
    opacity: number,
  ): Paint => {
    if (!value.startsWith('url(')) return { ...paint(color(value)), opacity }
    const e = ref(value),
      radial = e.localName === 'radialGradient'
    if (!radial && e.localName !== 'linearGradient')
      throw new Error(`不支持的 SVG 填充 ${e.localName}`)
    const parent = e.getAttribute('href') || e.getAttribute('xlink:href'),
      base = parent ? xml.getElementById(parent.slice(1)) : null
    const attr = (key: string, defaultValue: string) =>
      e.getAttribute(key) || base?.getAttribute(key) || defaultValue
    if (attr('spreadMethod', 'pad') !== 'pad')
      throw new Error('SVG 重复或镜像渐变暂不能无损导入；原文件未修改')
    const coordinate = (s: string) => (s.endsWith('%') ? Number.parseFloat(s) / 100 : Number(s))
    const user = attr('gradientUnits', 'objectBoundingBox') === 'userSpaceOnUse',
      transform = svgTransform(attr('gradientTransform', ''))
    const normalized = (p: { x: number; y: number }) => {
      p = apply(transform, p)
      return user ? { x: (p.x - box.x) / n.width, y: (p.y - box.y) / n.height } : p
    }
    const stops = Array.from((e.children.length ? e : base || e).children)
      .filter((s) => s.localName === 'stop')
      .map((s) => {
        const inline = Object.fromEntries(
          (s.getAttribute('style') || '')
            .split(';')
            .filter(Boolean)
            .map((x) => x.split(':').map((x) => x.trim())),
        )
        if (Number(s.getAttribute('stop-opacity') || inline['stop-opacity'] || 1) !== 1)
          throw new Error('当前 SVG 导入不支持独立色标透明度')
        return {
          offset: coordinate(s.getAttribute('offset') || '0'),
          color: color(s.getAttribute('stop-color') || inline['stop-color'] || '#000000'),
        }
      })
    if (!stops.length) throw new Error('SVG 渐变没有色标')
    if (stops.length === 1) stops.push({ ...stops[0], offset: 1 })
    let m: Matrix
    if (radial) {
      const cx = coordinate(attr('cx', '.5')),
        cy = coordinate(attr('cy', '.5')),
        r = coordinate(attr('r', '.5'))
      if (attr('fx', String(cx)) !== String(cx) || attr('fy', String(cy)) !== String(cy))
        throw new Error('当前 SVG 导入不支持偏心径向渐变')
      const a = normalized({ x: cx - r, y: cy - r }),
        b = normalized({ x: cx + r, y: cy - r }),
        c = normalized({ x: cx - r, y: cy + r })
      m = [b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y, a.x, a.y]
    } else {
      const a = normalized({ x: coordinate(attr('x1', '0')), y: coordinate(attr('y1', '0')) }),
        b = normalized({ x: coordinate(attr('x2', '1')), y: coordinate(attr('y2', '0')) })
      m = [b.x - a.x, b.y - a.y, -(b.y - a.y), b.x - a.x, a.x, a.y]
    }
    return { ...paint(stops[0].color, radial ? 'radial' : 'linear'), opacity, stops, transform: m }
  }
  const attachMask = (
    el: Element,
    n: DesignNode,
    parent: string[],
    box: { x: number; y: number },
    style: Record<string, string>,
    depth: number,
  ) => {
    const inline = svgPresentation(el).inline
    const maskAttribute = inline.mask || el.getAttribute('mask'),
      clipAttribute = inline['clip-path'] || el.getAttribute('clip-path')
    const maskValue = maskAttribute && maskAttribute !== 'none' ? maskAttribute : null,
      clipValue = clipAttribute && clipAttribute !== 'none' ? clipAttribute : null
    if (!maskValue && !clipValue) return n.id
    if (maskValue && clipValue) throw new Error('请将同时含 mask 与 clip-path 的 SVG 拆成嵌套组')
    const definition = ref((maskValue || clipValue)!),
      wrapper = node('group', 0, 0, n.width, n.height)
    wrapper.name = n.name + ' / ' + (maskValue ? '蒙版' : '裁剪')
    wrapper.fills = []
    wrapper.transform = n.transform
    n.transform = identity()
    wrapper.children = [n.id]
    const mask = node('group', 0, 0, n.width, n.height)
    mask.name = 'SVG mask'
    mask.fills = []
    mask.mask = true
    mask.maskType = clipValue
      ? 'alpha'
      : definition.getAttribute('mask-type') === 'alpha'
        ? 'alpha'
        : 'luminance'
    const units =
      definition.getAttribute(clipValue ? 'clipPathUnits' : 'maskContentUnits') || 'userSpaceOnUse'
    if (units !== 'objectBoundingBox' && units !== 'userSpaceOnUse')
      throw new Error(`不支持的 SVG 蒙版坐标单位 ${units}`)
    if (units === 'objectBoundingBox' && n.kind === 'group')
      throw new Error('SVG 容器的 objectBoundingBox 裁剪或蒙版内容暂不能无损导入，请先展开；原文件未修改')
    const definitionStyle = svgPresentation(definition).inline
    if (definitionStyle.transform || definitionStyle['transform-origin'])
      throw new Error('SVG 裁剪定义的 CSS 变换暂不能无损导入，请转换为 transform 属性')
    if (!clipValue && definition.hasAttribute('transform'))
      throw new Error('SVG mask 定义的 transform 暂不能无损导入，请将变换放入其内容组')
    const maskSpace: Matrix =
      units === 'objectBoundingBox' ? [n.width, 0, 0, n.height, 0, 0] : translate(-box.x, -box.y)
    mask.transform = multiply(maskSpace, svgTransform(definition.getAttribute('transform') || ''))
    doc.nodes[mask.id] = mask
    doc.nodes[wrapper.id] = wrapper
    wrapper.children.unshift(mask.id)
    for (const source of definition.children) {
      const child = source.cloneNode(true) as Element
      if (clipValue)
        for (const shape of [child, ...child.querySelectorAll('*')]) {
          shape.setAttribute('fill', '#ffffff')
          shape.setAttribute('stroke', 'none')
          shape.removeAttribute('style')
          const rule = shape.getAttribute('clip-rule')
          if (rule) shape.setAttribute('fill-rule', rule)
        }
      visit(child, mask.children, style, depth + 1)
    }
    const at = parent.indexOf(n.id)
    parent.splice(at, 1, wrapper.id)
    return wrapper.id
  }
  const visit = (
    el: Element,
    parent: string[],
    inherited: Record<string, string>,
    depth = 0,
  ): string | undefined => {
    if (depth > 64 || ++count > 20000) throw new Error('SVG 节点或层级超限')
    const tag = el.localName
    if (['defs', 'title', 'desc', 'metadata'].includes(tag)) return
    if (tag === 'svg')
      throw new Error('嵌套 SVG 视口暂不能无损导入，请先展开为单一视口；原文件未修改')
    if (['script', 'foreignObject', 'style', 'animate', 'animateTransform', 'set'].includes(tag))
      throw new Error(`SVG ${tag} 尚不能转换为可编辑图层`)
    if (Array.from(el.attributes).some((a) => /^on/i.test(a.name)))
      throw new Error('SVG 事件脚本不能导入')
    const { style, inline, opacity, display } = svgPresentation(el, inherited)
    if (el.getAttribute('filter') || inline.filter)
      throw new Error('SVG 滤镜导入需要先展开；请使用原始矢量或 PNG')
    if (tag === 'use') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || ''
      if (!href.startsWith('#')) throw new Error('SVG 外部引用不能导入')
      const target = xml.getElementById(href.slice(1))
      if (!target) throw new Error('SVG use 引用不存在')
      const g = node('group')
      g.fills = []
      g.opacity = opacity
      g.visible = display !== 'none'
      g.transform = multiply(
        svgTransform(el.getAttribute('transform') || ''),
        translate(length(el, 'x'), length(el, 'y')),
      )
      doc.nodes[g.id] = g
      parent.push(g.id)
      visit(target, g.children, style, depth + 1)
      return attachMask(el, g, parent, { x: 0, y: 0 }, style, depth)
    }
    const n = node(
      tag === 'g' || tag === 'svg'
        ? 'group'
        : tag === 'rect' || tag === 'image'
          ? 'rectangle'
          : tag === 'circle' || tag === 'ellipse'
            ? 'ellipse'
            : tag === 'text'
              ? 'text'
              : 'vector',
    )
    n.name = el.getAttribute('id') || tag
    n.fills = []
    n.strokes = []
    n.transform = svgTransform(el.getAttribute('transform') || '')
    n.opacity = opacity
    // visibility inherits but may be overridden below a hidden container;
    // display:none suppresses the entire subtree and cannot be overridden.
    n.visible =
      display !== 'none' &&
      (tag === 'g' || tag === 'svg' || !['hidden', 'collapse'].includes(style.visibility))
    const box = { x: 0, y: 0 }
    if (tag === 'g' || tag === 'svg') {
      doc.nodes[n.id] = n
      parent.push(n.id)
      for (const child of el.children) visit(child, n.children, style, depth + 1)
      return attachMask(el, n, parent, box, style, depth)
    }
    if (tag === 'rect' || tag === 'image') {
      box.x = length(el, 'x')
      box.y = length(el, 'y')
      n.width = length(el, 'width')
      n.height = length(el, 'height')
      if (tag === 'rect') {
        const rx = length(el, 'rx', length(el, 'ry')), ry = length(el, 'ry', rx)
        if (rx !== ry)
          throw new Error('SVG 椭圆圆角暂不能无损导入，请先转换为路径；原文件未修改')
      }
      n.radii = [1, 1, 1, 1].map(() => length(el, 'rx', length(el, 'ry'))) as [
        number,
        number,
        number,
        number,
      ]
    } else if (tag === 'circle' || tag === 'ellipse') {
      const rx = length(el, tag === 'circle' ? 'r' : 'rx'),
        ry = length(el, tag === 'circle' ? 'r' : 'ry')
      n.width = rx * 2
      n.height = ry * 2
      box.x = length(el, 'cx') - rx
      box.y = length(el, 'cy') - ry
    } else if (tag === 'text') {
      if (el.children.length) throw new Error('SVG tspan 请先转换为轮廓或拆分文本图层')
      n.text = el.textContent || ''
      n.fontSize = Number.parseFloat(style['font-size'] || '16')
      n.textStyle = { ...defaultTextStyle(), weight: Number(style['font-weight']) || 400 }
      n.width = Math.max(1, n.text.length * n.fontSize)
      n.height = n.fontSize * 1.35
      box.x = length(el, 'x')
      box.y = length(el, 'y') - n.fontSize
      if (style['font-family'])
        warnings.add(`字体 ${style['font-family']} 需要在导入后匹配；当前使用内置字体`)
      if (style['text-anchor'] && style['text-anchor'] !== 'start')
        warnings.add('SVG 文本锚点需要检查')
    } else {
      let data = el.getAttribute('d') || ''
      if (tag === 'line')
        data = `M${length(el, 'x1')} ${length(el, 'y1')}L${length(el, 'x2')} ${length(el, 'y2')}`
      else if (tag === 'polygon' || tag === 'polyline')
        data = 'M' + (el.getAttribute('points') || '') + (tag === 'polygon' ? 'Z' : '')
      else if (tag !== 'path') throw new Error(`SVG ${tag} 尚不支持`)
      n.network = pathNetwork(data)
      n.network.fillRule = style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero'
      const b = kernelBounds(n)
      if (b) {
        box.x = b.x
        box.y = b.y
        n.width = Math.max(0.01, b.width)
        n.height = Math.max(0.01, b.height)
        for (const v of n.network.vertices) {
          v.x -= b.x
          v.y -= b.y
        }
        for (const e of n.network.edges)
          for (const p of [e.c1, e.c2])
            if (p) {
              p.x -= b.x
              p.y -= b.y
            }
      }
    }
    n.transform = multiply(n.transform, translate(box.x, box.y))
    if (tag === 'image') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || ''
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(href))
        throw new Error('SVG 图片必须内嵌 PNG/JPEG/WebP')
      const aspect = (el.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim()
      if (!['none', 'xMidYMid', 'xMidYMid meet', 'xMidYMid slice'].includes(aspect))
        throw new Error('SVG 图片的非居中对齐暂不能无损导入；原文件未修改')
      n.fills = [
        {
          ...paint('#ffffff', 'image'),
          image: href,
          fit: aspect === 'none' ? 'stretch' : aspect.endsWith('slice') ? 'cover' : 'contain',
        },
      ]
    } else if (style.fill !== 'none')
      n.fills = [makePaint(svgPaintValue(style.fill || '#000000', style), n, box, Number(style['fill-opacity'] || 1))]
    if (style.stroke && style.stroke !== 'none') {
      const s = stroke('#000000', Number(style['stroke-width'] || 1))
      s.paint = makePaint(svgPaintValue(style.stroke, style), n, box, Number(style['stroke-opacity'] || 1))
      s.cap = (style['stroke-linecap'] || 'butt') as typeof s.cap
      s.join = (style['stroke-linejoin'] || 'miter') as typeof s.join
      s.dash = style['stroke-dasharray'] === 'none' ? '' : style['stroke-dasharray'] || ''
      s.dashOffset = Number(style['stroke-dashoffset'] || 0)
      n.strokes = [s]
    }
    doc.nodes[n.id] = n
    parent.push(n.id)
    return attachMask(el, n, parent, box, style, depth)
  }
  const vb = parseSvgViewBox(root.getAttribute('viewBox'))
  const frame = node(
    'frame',
    0,
    0,
    length(root, 'width', vb ? vb[2] : 800),
    length(root, 'height', vb ? vb[3] : 600),
  )
  frame.name = name
  frame.fills = []
  frame.clip = true
  // Apply opacity once to the viewport group, never once per overlapping child.
  frame.opacity = rootPresentation.opacity
  frame.visible = rootPresentation.display !== 'none'
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  for (const e of root.children)
    visit(e, frame.children, rootPresentation.style)
  if (vb) {
    const m = svgViewportTransform(vb, frame.width, frame.height, root.getAttribute('preserveAspectRatio'))
    for (const id of frame.children) doc.nodes[id].transform = multiply(m, doc.nodes[id].transform)
  }
  doc.schemaVersion = 4
  return { document: doc, warnings: [...warnings] }
}
