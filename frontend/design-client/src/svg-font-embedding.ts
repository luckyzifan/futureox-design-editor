import { font_faces_json } from './generated/design-kernel/design_kernel'
import type { DesignDocument } from './model'

export const EMBEDDED_FONT_WARNING = 'Caller-authorized local fonts are embedded whole, without subsetting. OS/2 flags are checked but do not establish a legal license. Hosts may ignore SVG embedded fonts; unavailable default/fallback fonts and shaping differences can still change appearance. Outlines remain the visual-fidelity default.'
export const SVG_FONT_BYTES = 4 * 1024 * 1024
// Escape every code point: family names can never terminate a CSS string or XML style.
const cssString = (value: string) => '"' + Array.from(value, c => `\\${c.codePointAt(0)!.toString(16)} `).join('') + '"'
export function inspectSvgFont(data: string, index = 0, maxBytes = SVG_FONT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 24 * 1024 * 1024) throw new Error('Invalid SVG font byte budget')
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(maxBytes / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('SVG font exceeds its byte budget or has invalid base64')
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
  if (bytes.length > maxBytes) throw new Error('SVG embedded fonts exceed their byte budget')
  const view = new DataView(bytes.buffer)
  const u16 = (at: number) => { if (at < 0 || at + 2 > bytes.length) throw new Error('Truncated SVG font'); return view.getUint16(at) }
  const u32 = (at: number) => { if (at < 0 || at + 4 > bytes.length) throw new Error('Truncated SVG font'); return view.getUint32(at) }
  const signature = u32(0)
  if (signature === 0x74746366) throw new Error('SVG font embedding requires a standalone face; TTC collections cannot be silently extracted')
  if (![0x00010000, 0x4f54544f].includes(signature)) throw new Error('SVG font embedding requires validated TTF or OTF; WOFF/WOFF2 must be decoded by a trusted font importer first')
  if (index !== 0) throw new Error('Standalone SVG font face index must be zero')
  const faces = JSON.parse(font_faces_json(bytes)) as { index: number }[]
  if (!faces.some(f => f.index === 0)) throw new Error('Invalid SVG font face')
  const count = u16(4)
  if (count > 4096) throw new Error('SVG font table budget exceeded')
  let flags: number | undefined
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, tag = u32(at), offset = u32(at + 8), length = u32(at + 12)
    if (offset + length > bytes.length) throw new Error('Invalid SVG font table bounds')
    if (tag === 0x4f532f32) { if (flags !== undefined || length < 10) throw new Error('Invalid OS/2 embedding rights'); flags = u16(offset + 8) }
  }
  // Unknown/reserved rights are not permission. No-subsetting is honored by copying all bytes.
  if (flags === undefined || (flags & ~0x010e) || (flags & 2) || ((flags & 4) && !(flags & 8))) throw new Error('Font embedding rights prohibit editable SVG embedding')
  return { bytes: bytes.length, mime: signature === 0x4f54544f ? 'font/otf' : 'font/ttf', format: signature === 0x4f54544f ? 'opentype' : 'truetype', flags }
}
export function svgFontCss(family: string, data: string, index = 0, maxBytes = SVG_FONT_BYTES) {
  if (!family || family.length > 200) throw new Error('Invalid SVG embedded font family')
  const font = inspectSvgFont(data, index, maxBytes)
  return { ...font, css: `@font-face{font-family:${cssString(family)};src:url("data:${font.mime};base64,${data}") format("${font.format}");}` }
}
export function svgEmbeddedFonts(fonts: DesignDocument['fonts'], usedIds?: Set<string>, maxBytes = SVG_FONT_BYTES) {
  let total = 0
  return Object.entries(fonts || {}).filter(([id]) => !usedIds || usedIds.has(id) || id === '__svg_bundled_default' && usedIds.has('default')).map(([id, font]) => {
    const checked = svgFontCss(font.family, font.data, font.index, maxBytes)
    total += checked.bytes
    if (total > maxBytes) throw new Error('SVG embedded fonts exceed their total byte budget')
    return { id, family: font.family, css: checked.css }
  })
}
/** Only our canonical, local-only font rules are accepted, never arbitrary CSS. */
export function readSvgEmbeddedFonts(root: Element, existing: DesignDocument['fonts'], maxBytes = SVG_FONT_BYTES): DesignDocument['fonts'] {
  const fonts = { ...existing }; let total = 0
  for (const style of Array.from(root.querySelectorAll('style'))) {
    if (style.parentElement?.localName !== 'defs' || style.getAttribute('data-svg-font') !== '1' || style.children.length || Array.from(style.attributes).some(a => !['data-svg-font', 'data-font-id', 'data-font-family'].includes(a.name))) throw new Error('Unsupported SVG stylesheet')
    const id = style.getAttribute('data-font-id') || '', family = style.getAttribute('data-font-family') || '', css = style.textContent || ''
    if (!id || ['default','__proto__','constructor','prototype'].includes(id) || new TextEncoder().encode(id).length > 128 || Object.keys(fonts).length >= 32) throw new Error('Invalid embedded SVG font ID or budget')
    const match = /url\("data:font\/(?:ttf|otf);base64,([A-Za-z0-9+/]+={0,2})"\)/.exec(css)
    if (!match) throw new Error('SVG fonts require local TTF/OTF data URIs')
    const checked = svgFontCss(family, match[1], 0, maxBytes); total += checked.bytes
    if (total > maxBytes || css !== checked.css) throw new Error('Invalid SVG font CSS or byte budget')
    if (fonts[id] && (fonts[id].data !== match[1] || fonts[id].family !== family)) throw new Error('Conflicting embedded SVG font ID')
    fonts[id] = { family, data: match[1], index: 0 }
  }
  return Object.keys(fonts).length ? fonts : undefined
}
