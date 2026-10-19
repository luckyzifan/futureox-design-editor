// SVG numeric grammar, deliberately independent from the path-data parser.
const numberSource = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const number = new RegExp(`^${numberSource}$`)
const token = new RegExp(numberSource, 'y')
const length = new RegExp(`^(${numberSource})(px|in|cm|mm|q|pt|pc)?$`, 'i')
const scales: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 }

export function svgNumber(value: string, label: string): number {
  const source = value.trim(), parsed = Number(source)
  if (!number.test(source) || !Number.isFinite(parsed)) throw new Error(`SVG ${label} 需要有限数值`)
  return parsed
}

/** CSS Transforms 1 §7.2 permits adjacent signed/decimal number tokens. */
export function svgNumberList(value: string, label: string, adjacent = false): number[] {
  const source = value.trim(), values: number[] = []
  let at = 0
  while (at < source.length) {
    token.lastIndex = at
    const match = token.exec(source)
    if (!match) throw new Error(`SVG ${label} 数值列表无效`)
    values.push(svgNumber(match[0], label))
    if (values.length > 6) throw new Error(`SVG ${label} 参数数量超限`)
    at = token.lastIndex
    if (at === source.length) break
    const separator = /^[\t\n\r ]*(?:,[\t\n\r ]*)?/.exec(source.slice(at))![0]
    if (!separator && !adjacent) throw new Error(`SVG ${label} 数值列表缺少分隔符`)
    at += separator.length
    if (at === source.length) throw new Error(`SVG ${label} 数值列表不能以逗号结尾`)
  }
  return values
}

/** CSS absolute units use a 96px reference inch, in the current user space. */
export function svgAbsoluteLength(value: string, label: string): number {
  const match = length.exec(value.trim())
  if (!match) throw new Error(`SVG ${label} 需要绝对长度（px/in/cm/mm/Q/pt/pc）；相对单位暂不能无损导入`)
  const result = Number(match[1]) * scales[(match[2] || 'px').toLowerCase()]
  if (!Number.isFinite(result)) throw new Error(`SVG ${label} 需要有限长度`)
  return result
}

export function svgFraction(value: string, label: string): number {
  const source = value.trim()
  return source.endsWith('%') ? svgNumber(source.slice(0, -1), label) / 100 : svgNumber(source, label)
}

export function svgStrokeDasharray(value: string): string {
  const source = value.trim()
  if (!source || source === 'none') return ''
  if (source.length > 1000 || /^,|,$|,\s*,/.test(source)) throw new Error('SVG stroke-dasharray 无效或超限')
  const result = source.split(/[\s,]+/).map(part => {
    const length = svgAbsoluteLength(part, 'stroke-dasharray')
    if (length < 0 || length > 1e7 || (length > 0 && length < 1e-6)) throw new Error('SVG stroke-dasharray 超出可编辑精度范围')
    return String(length)
  }).join(' ')
  if (result.length > 1000) throw new Error('SVG stroke-dasharray 规范化后超限')
  return result
}
