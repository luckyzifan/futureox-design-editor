import { readSvgEmbeddedFonts, EMBEDDED_FONT_WARNING } from './svg-font-embedding'
import { readEditableSvgText, EDITABLE_TEXT_WARNING } from './svg-editable-text'
import {
  blank,
  hasSchema20Features,
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
import { multiply, translate, rotate } from './geometry'
import { kernelBounds } from './kernel/picking'
import { svgPaintValue, svgPresentation, svgRootPresentation } from './svg-presentation'
import { parseSvgViewBox, svgViewportTransform } from './import-svg-viewport'
import { pathNetwork } from './path-network'
import { svgAbsoluteLength, svgNumberList, svgFraction, svgStrokeDasharray } from './svg-values'
import { svgColorParser } from './svg-color'
import { svgGradientParser } from './svg-gradient'
export { pathNetwork } from './path-network'
export type ImportedDesign = { document: DesignDocument; warnings: string[]; droppedOccurrences?: number }
const transformArities: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] }
export function svgTransform(value: string): Matrix {
  let result = identity(),
    end = 0, count = 0
  const source = value.trim(), operation = /([a-zA-Z]+)\s*\(([^()]*)\)/y
  while (end < source.length) {
    const separator = (end ? /^\s*(?:,\s*)?/ : /^\s*/).exec(source.slice(end))![0]
    end += separator.length
    operation.lastIndex = end
    const match = operation.exec(source)
    if (!match) throw new Error('SVG 变换语法无效')
    if (++count > 20000) throw new Error('SVG 变换超过 20000 项')
    end = operation.lastIndex
    const a = svgNumberList(match[2], '变换', true)
    if (Object.hasOwn(transformArities, match[1]) && !transformArities[match[1]].includes(a.length))
      throw new Error(`SVG ${match[1]} 参数数量无效`)
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
          multiply(translate(a[1] || 0, a[2] || 0), rotate(a[0])),
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
    if (!result.every(Number.isFinite)) throw new Error('SVG 变换超出有限数值范围')
  }
  return result
}
export function importSvg(source: string, name = '导入 SVG', fonts?: DesignDocument['fonts'], budget: {sourceChars:number;fontBytes:number;strictTree?:boolean} = {sourceChars:16 * 1024 * 1024,fontBytes:4 * 1024 * 1024}): ImportedDesign {
  if (!Number.isSafeInteger(budget.sourceChars) || budget.sourceChars < 1 || budget.sourceChars > 48 * 1024 * 1024 || !Number.isSafeInteger(budget.fontBytes) || budget.fontBytes < 1 || budget.fontBytes > 24 * 1024 * 1024 || (budget.sourceChars > 16 * 1024 * 1024 || budget.fontBytes > 4 * 1024 * 1024) && !budget.strictTree) throw new Error('Invalid SVG import budget')
  if (source.length > budget.sourceChars || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('SVG 大小或声明不受支持')
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml'),
    root = xml.documentElement
  if (root.localName !== 'svg' || xml.querySelector('parsererror')) throw new Error('SVG XML 无效')
  if (Array.from(root.attributes).some((attribute) => /^on/i.test(attribute.name)))
    throw new Error('SVG 事件脚本不能导入')
  if (budget.strictTree) {
    const pending: Array<{element:Element;depth:number}> = [{element:root,depth:0}]; let count=0
    while (pending.length) {
      const {element,depth}=pending.pop()!
      if (++count>20000 || depth>64) throw new Error('SVG artifact node/depth budget exceeded')
      if (element.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('SVG artifact namespace is unsupported')
      const supportedStyle = new Set(['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','font-size','font-family','font-weight','text-anchor','visibility','color','opacity','display'])
      for (const declaration of (element.getAttribute('style')||'').split(';').filter(Boolean)) {
        const colon=declaration.indexOf(':'), property=declaration.slice(0,colon).trim(), value=declaration.slice(colon+1).trim()
        if (colon<1 || !supportedStyle.has(property) && !(property==='mix-blend-mode'&&value==='normal') && !(property==='white-space'&&value==='pre') && !(property==='isolation'&&['auto','isolate'].includes(value))) throw new Error('Unsupported SVG artifact inline style')
      }
      for (const attribute of Array.from(element.attributes)) {
        if ((attribute.name === 'href' || attribute.name === 'xlink:href') && !attribute.value.startsWith('#') && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(attribute.value)) throw new Error('SVG artifact external URL is forbidden')
        if (/url\(/i.test(attribute.value) && !/^url\(#[^\s)]+\)$/.test(attribute.value) && attribute.name !== 'data-text-model') throw new Error('SVG artifact external or complex URL is forbidden')
      }
      for (const child of Array.from(element.children)) pending.push({element:child,depth:depth+1})
    }
  }
  // Definitions are not painted during traversal, but must not conceal scripts.
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (['script','foreignObject','animate','animateTransform','set'].includes(element.localName) || Array.from(element.attributes).some(a => /^on/i.test(a.name))) throw new Error('SVG 动态或活动内容不能导入')
  }
  const rootPresentation = svgRootPresentation(root)
  const doc = blank(name),
    warnings = new Set<string>()
  fonts = readSvgEmbeddedFonts(root, fonts, budget.fontBytes)
  doc.fonts = fonts
  const editableFontWarning = root.querySelector('style[data-svg-font="1"]') ? EMBEDDED_FONT_WARNING : EDITABLE_TEXT_WARNING
  let editableText = false
  let count = 0
  const admitElement = (depth: number) => {
    if (depth > 64 || ++count > 20000) throw new Error('SVG 节点或层级超限')
  }
  const length = (el: Element, key: string, fallback = 0) => {
    const value = el.getAttribute(key)
    if (value === null || value === '') return fallback
    const parsed = svgAbsoluteLength(value, key)
    if (['width', 'height', 'r', 'rx', 'ry'].includes(key) && parsed < 0) throw new Error(`SVG ${key} 不能为负数`)
    return parsed
  }
  const color = svgColorParser()
  const gradient = svgGradientParser(xml, color, svgTransform)
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
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('SVG 绘制透明度必须为 0–1')
    if (!value.startsWith('url(')) return { ...paint(color(value)), opacity }
    return gradient(ref(value), n, box, viewport, opacity)
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
    admitElement(depth)
    const tag = el.localName
    if (['defs', 'title', 'desc', 'metadata'].includes(tag)) return
    if (tag === 'svg')
      throw new Error('嵌套 SVG 视口暂不能无损导入，请先展开为单一视口；原文件未修改')
    if (['script', 'foreignObject', 'style', 'animate', 'animateTransform', 'set'].includes(tag))
      throw new Error(`SVG ${tag} 尚不能转换为可编辑图层`)
    if (Array.from(el.attributes).some((a) => /^on/i.test(a.name)))
      throw new Error('SVG 事件脚本不能导入')
    const { style, inline, opacity, display } = svgPresentation(el, inherited)
    if ((inline.transform && inline.transform !== 'none') || inline['transform-origin'] || el.hasAttribute('transform-origin'))
      throw new Error('SVG CSS transform/transform-origin 暂不能无损导入，请转换为 transform 属性；原文件未修改')
    const transformValue = inline.transform === 'none' ? '' : el.getAttribute('transform') || ''
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('SVG opacity 必须为 0–1')
    if ((inline.filter || el.getAttribute('filter')) && (inline.filter || el.getAttribute('filter')) !== 'none')
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
        svgTransform(transformValue),
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
    n.transform = svgTransform(transformValue)
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
      if (readEditableSvgText(el, n, fonts, relativeDepth => admitElement(depth + relativeDepth))) {
        editableText = true
        warnings.add(editableFontWarning)
        warnings.add('Editable SVG imports its validated text model; unavailable font IDs use the built-in font. Visual equivalence is not guaranteed.')
      } else {
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
      }
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
      n.fills = [makePaint(svgPaintValue(style.fill || '#000000', style), n, box, svgFraction(style['fill-opacity'] || '1', 'fill-opacity'))]
    if (style.stroke && style.stroke !== 'none') {
      const width = svgAbsoluteLength(style['stroke-width'] || '1', 'stroke-width')
      if (width < 0) throw new Error('SVG stroke-width 不能为负数')
      const s = stroke('#000000', width)
      s.paint = makePaint(svgPaintValue(style.stroke, style), n, box, svgFraction(style['stroke-opacity'] || '1', 'stroke-opacity'))
      s.cap = (style['stroke-linecap'] || 'butt') as typeof s.cap
      s.join = (style['stroke-linejoin'] || 'miter') as typeof s.join
      s.dash = svgStrokeDasharray(style['stroke-dasharray'] || '')
      s.dashOffset = svgAbsoluteLength(style['stroke-dashoffset'] || '0', 'stroke-dashoffset')
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
  if (frame.width <= 0 || frame.height <= 0) throw new Error('SVG 视口需要正的有限尺寸')
  const viewport = { width: vb?.[2] ?? frame.width, height: vb?.[3] ?? frame.height }
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
  doc.schemaVersion = hasSchema20Features(doc) ? 20 : editableText ? 15 : 4
  return { document: doc, warnings: [...warnings] }
}
