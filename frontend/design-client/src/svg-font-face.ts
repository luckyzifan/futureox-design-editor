/** CSS descriptors shared by editable SVG text and @font-face. The family
 * string is what the text element can see; italic follows that string so the
 * face rule and the element request the same style. */
export type SvgFaceMetrics = {
  weight?: number
  italic?: boolean
  variable?: boolean
  axes?: ReadonlyArray<{ tag: string; min: number; max: number }>
}

export function cssFontStyle(family: string): 'italic' | 'normal' {
  return /italic|oblique/i.test(family) ? 'italic' : 'normal'
}

function weightToken(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 1 || value > 1000) return undefined
  return String(Math.round(value))
}

/** `legacy` is the previously shipped rule, accepted on import. New exports
 * add font-style and, when the face is known, font-weight or a wght range. */
export function svgFontFaceCss(family: string, data: string, mime: string, format: string, face?: SvgFaceMetrics, legacy = false): string {
  const quoted = '"' + Array.from(family, character => `\\${character.codePointAt(0)!.toString(16)} `).join('') + '"'
  if (legacy) return `@font-face{font-family:${quoted};src:url("data:${mime};base64,${data}") format("${format}");}`
  const style = cssFontStyle(family)
  const axis = face?.axes?.find(item => item.tag === 'wght')
  const range = face?.variable && axis && axis.min < axis.max ? [weightToken(axis.min), weightToken(axis.max)] : undefined
  const weight = range?.[0] && range[1] ? `${range[0]} ${range[1]}` : weightToken(face?.weight ?? NaN)
  const descriptors = `font-style:${style};${weight ? `font-weight:${weight};` : ''}`
  return `@font-face{font-family:${quoted};${descriptors}src:url("data:${mime};base64,${data}") format("${format}");}`
}
