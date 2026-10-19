/** One cache/context per import: no retained document state and no asset loads. */
export function svgColorParser() {
  const cache = new Map<string, string>()
  let context: CanvasRenderingContext2D | null | undefined
  return (value: string): string => {
    const cached = cache.get(value)
    if (cached !== undefined) return cached
    const source = value.trim()
    let result: string
    if (/^#[0-9a-f]{6}$/i.test(source)) result = source.toLowerCase()
    else if (/^#[0-9a-f]{3}$/i.test(source)) result = '#' + [...source.slice(1)].map(c => c + c).join('').toLowerCase()
    else {
      context ??= document.createElement('canvas').getContext('2d')
      if (!context) throw new Error(`当前环境无法解析 SVG 颜色 ${value}`)
      context.fillStyle = '#010203'
      context.fillStyle = source
      const first = context.fillStyle
      context.fillStyle = '#030201'
      context.fillStyle = source
      if (context.fillStyle !== first) throw new Error(`不支持的 SVG 颜色 ${value}`)
      if (/^#[0-9a-f]{6}$/i.test(first)) result = first
      else {
        const match = String(first).match(/^rgba?\(([^)]+)\)$/)
        if (!match) throw new Error(`不支持的 SVG 颜色 ${value}`)
        const parts = match[1].split(',').map(Number)
        if (parts[3] !== undefined && parts[3] !== 1) throw new Error('请使用 fill-opacity 表达透明颜色')
        if (parts.length < 3 || !parts.every(Number.isFinite)) throw new Error(`不支持的 SVG 颜色 ${value}`)
        result = '#' + parts.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
      }
    }
    cache.set(value, result)
    return result
  }
}
