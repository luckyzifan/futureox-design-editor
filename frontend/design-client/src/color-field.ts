/** sRGB field math for the color popover and the eyedropper readout.
 * Document colors stay `#rrggbb` or authored CSS. These helpers only format
 * the Mac-style Hex / RGB / HSL / HSB fields. */
export type ColorNotation = 'HEX' | 'RGB' | 'HSB' | 'HSL'

export function parseHex(color: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null
  return [1, 3, 5].map(at => Number.parseInt(color.slice(at, at + 2), 16)) as [number, number, number]
}

export function formatHex(rgb: readonly [number, number, number]): string {
  return '#' + rgb.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')
}

function hueOf(max: number, r: number, g: number, b: number, span: number) {
  if (span === 0) return 0
  const raw = max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  return (raw * 60 + 360) % 360
}

export function rgbToHsb(r: number, g: number, b: number) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), span = max - min
  return { h: hueOf(max, R, G, B, span), s: max === 0 ? 0 : span / max, b: max }
}

export function rgbToHsl(r: number, g: number, b: number) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), span = max - min, light = (max + min) / 2
  return { h: hueOf(max, R, G, B, span), s: span === 0 ? 0 : span / (1 - Math.abs(2 * light - 1)), l: light }
}

function sector(h: number, c: number, x: number): [number, number, number] {
  if (h < 60) return [c, x, 0]
  if (h < 120) return [x, c, 0]
  if (h < 180) return [0, c, x]
  if (h < 240) return [0, x, c]
  if (h < 300) return [x, 0, c]
  return [c, 0, x]
}

export function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  const H = ((h % 360) + 360) % 360
  const c = Math.max(0, Math.min(1, b)) * Math.max(0, Math.min(1, s))
  const x = c * (1 - Math.abs((H / 60) % 2 - 1))
  const m = Math.max(0, Math.min(1, b)) - c
  const [r, g, bl] = sector(H, c, x)
  return [(r + m) * 255, (g + m) * 255, (bl + m) * 255]
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const H = ((h % 360) + 360) % 360
  const light = Math.max(0, Math.min(1, l))
  const c = (1 - Math.abs(2 * light - 1)) * Math.max(0, Math.min(1, s))
  const x = c * (1 - Math.abs((H / 60) % 2 - 1))
  const m = light - c / 2
  const [r, g, b] = sector(H, c, x)
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** Compact readout used by the eyedropper tooltip. `#D9D9D9` is `HSB 0° 0 85`. */
export function eyedropperReadout(hex: string, notation: ColorNotation = 'HSB'): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex.toUpperCase()
  if (notation === 'HEX') return hex.slice(1).toUpperCase()
  if (notation === 'RGB') return `RGB ${rgb.map(value => Math.round(value)).join(' ')}`
  if (notation === 'HSL') {
    const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2])
    return `HSL ${Math.round(hsl.h)}° ${Math.round(hsl.s * 100)} ${Math.round(hsl.l * 100)}`
  }
  const hsb = rgbToHsb(rgb[0], rgb[1], rgb[2])
  return `HSB ${Math.round(hsb.h)}° ${Math.round(hsb.s * 100)} ${Math.round(hsb.b * 100)}`
}

export function notationChannels(hex: string, notation: Exclude<ColorNotation, 'HEX'>): [number, number, number] {
  const rgb = parseHex(hex) ?? [0, 0, 0]
  if (notation === 'RGB') return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])]
  if (notation === 'HSB') {
    const hsb = rgbToHsb(rgb[0], rgb[1], rgb[2])
    return [Math.round(hsb.h), Math.round(hsb.s * 100), Math.round(hsb.b * 100)]
  }
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2])
  return [Math.round(hsl.h), Math.round(hsl.s * 100), Math.round(hsl.l * 100)]
}

export function applyNotationChannel(hex: string, notation: Exclude<ColorNotation, 'HEX'>, index: number, raw: number): string {
  const channels = notationChannels(hex, notation)
  const max = notation === 'RGB' ? 255 : index === 0 ? 360 : 100
  channels[index] = Math.max(0, Math.min(max, Math.round(raw)))
  if (notation === 'RGB') return formatHex(channels)
  if (notation === 'HSB') return formatHex(hsbToRgb(channels[0], channels[1] / 100, channels[2] / 100))
  return formatHex(hslToRgb(channels[0], channels[1] / 100, channels[2] / 100))
}

export function nearestStopIndex(stops: readonly { offset: number }[], offset: number) {
  let best = 0, distance = Number.POSITIVE_INFINITY
  stops.forEach((stop, index) => {
    const next = Math.abs(stop.offset - offset)
    if (next < distance) { distance = next; best = index }
  })
  return best
}

type SwatchNode = {
  fills?: readonly { kind?: string; color?: string; visible?: boolean }[]
  strokes?: readonly { visible?: boolean; paint?: { kind?: string; color?: string; visible?: boolean } }[]
  children?: readonly string[]
}

/** Local file colors only: shared paint styles, then solid fills and strokes on this page. */
export function collectFileColors(doc: {
  designSystem?: { styles?: Record<string, { name: string; kind: string; value: unknown }> }
  pages: readonly { id: string; children: readonly string[] }[]
  nodes: Record<string, SwatchNode | undefined>
}, pageId: string): { styles: { name: string; color: string }[]; colors: string[] } {
  const styles: { name: string; color: string }[] = []
  for (const style of Object.values(doc.designSystem?.styles ?? {})) {
    if (style.kind !== 'paint' || !Array.isArray(style.value)) continue
    const solid = style.value.find(paint => paint && typeof paint === 'object' && (paint as { kind?: string }).kind === 'solid' && typeof (paint as { color?: string }).color === 'string' && /^#[0-9a-f]{6}$/i.test((paint as { color: string }).color)) as { color: string } | undefined
    if (solid) styles.push({ name: style.name, color: solid.color })
    if (styles.length >= 24) break
  }
  const colors: string[] = []
  const seen = new Set<string>()
  const visit = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (depth > 12 || visit.has(id) || colors.length >= 32) return
    visit.add(id)
    const node = doc.nodes[id]
    if (!node) return
    for (const paint of node.fills ?? []) {
      if (paint.visible === false || paint.kind !== 'solid' || !paint.color || !/^#[0-9a-f]{6}$/i.test(paint.color)) continue
      const key = paint.color.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key); colors.push(paint.color.toUpperCase())
    }
    for (const stroke of node.strokes ?? []) {
      const paint = stroke.paint
      if (stroke.visible === false || paint?.visible === false || paint?.kind !== 'solid' || !paint.color || !/^#[0-9a-f]{6}$/i.test(paint.color)) continue
      const key = paint.color.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key); colors.push(paint.color.toUpperCase())
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  const page = doc.pages.find(item => item.id === pageId)
  for (const id of page?.children ?? []) walk(id, 0)
  return { styles, colors }
}
