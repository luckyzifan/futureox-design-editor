export type NumericUnit = 'number' | 'length' | 'angle' | 'percent' | 'time'

/** Bounded arithmetic parser for property fields. Never executes JavaScript. */
export function numericExpression(source: string, base: number, unit: NumericUnit = 'number'): number {
  if (!source.trim() || source.length > 256 || !Number.isFinite(base)) throw new Error('数值表达式无效')
  const text = source.trim(), relative = text.match(/^([+\-*/])=(.*)$/s)
  let input = relative ? relative[2] : text, at = 0, depth = 0, tokens = 0
  const factors: Record<string, number> = unit === 'length' ? { px: 1, pt: 96 / 72, pc: 16, in: 96, mm: 96 / 25.4, cm: 96 / 2.54 }
    : unit === 'angle' ? { deg: 1, '°': 1, rad: 180 / Math.PI, turn: 360 }
      : unit === 'time' ? { ms: 1, s: 1000 } : {}
  const skip = () => { while (/\s/.test(input[at] || '') && at < input.length) at++ }
  const finite = (value: number) => { if (!Number.isFinite(value)) throw new Error('数值不能为无限值'); return value }
  function primary(): number {
    skip(); if (++tokens > 96 || ++depth > 16) throw new Error('数值表达式过长')
    let value: number
    if (input[at] === '+' || input[at] === '-') { const sign = input[at++]; value = primary() * (sign === '-' ? -1 : 1) }
    else if (input[at] === '(') { at++; value = sum(); skip(); if (input[at++] !== ')') throw new Error('括号不匹配') }
    else {
      const match = input.slice(at).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?/i)
      if (!match) throw new Error('需要数值')
      at += match[0].length; value = finite(Number(match[0]))
    }
    skip()
    if (input[at] === '%') { at++; value *= (relative && ['*', '/'].includes(relative[1]) ? 1 : unit === 'percent' ? 100 : base) / 100 }
    else {
      const suffix = input.slice(at).match(/^[a-z°]+/i)?.[0]
      if (suffix) {
        const factor = factors[suffix.toLowerCase()]
        if (factor === undefined) throw new Error('此属性不支持该单位')
        at += suffix.length; value *= factor
      }
    }
    depth--; return finite(value)
  }
  function product(): number {
    let value = primary(); skip()
    while (input[at] === '*' || input[at] === '/') { const op = input[at++], right = primary(); value = finite(op === '*' ? value * right : value / right); skip() }
    return value
  }
  function sum(): number {
    let value = product(); skip()
    while (input[at] === '+' || input[at] === '-') { const op = input[at++], right = product(); value = finite(op === '+' ? value + right : value - right); skip() }
    return value
  }
  let value = sum(); skip(); if (at !== input.length) throw new Error('数值表达式包含不支持的内容')
  if (relative) value = relative[1] === '+' ? base + value : relative[1] === '-' ? base - value : relative[1] === '*' ? base * value : base / value
  return finite(value)
}

/** 0–100 display. Two decimal places, trailing zeros removed. */
export function formatPercent(value: number) {
  if (!Number.isFinite(value)) return ''
  return String(Number(value.toFixed(2)))
}

export function propertyUnit(label: string): NumericUnit {
  if (label.includes('%')) return 'percent'
  if (/°|角度|旋转/.test(label)) return 'angle'
  if (/ms|毫秒|时长/.test(label)) return 'time'
  if (/^[XYWH]$|宽|高|尺寸|圆角|半径|字号|大小|间距|边距|位移|左上|右上|右下|左下|描边/.test(label)) return 'length'
  return 'number'
}
