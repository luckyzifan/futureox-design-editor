export const colorSpaces = [
  'srgb',
  'srgb-linear',
  'display-p3',
  'display-p3-linear',
  'rec2020',
  'rec2100-linear',
  'rec2100-pq',
  'rec2100-hlg',
  'a98-rgb',
  'prophoto-rgb',
  'xyz-d50',
  'xyz-d65',
] as const
export type ColorSpace = (typeof colorSpaces)[number]
export type ColorSettings = {
  documentSpace: ColorSpace
  referenceWhiteNits: number
  peakLuminanceNits: number
}
export type ColorOutput = { space: ColorSpace; toneMap: 'clip' | 'reinhard' | 'none' }
export const defaultColorSettings = (): ColorSettings => ({
  documentSpace: 'srgb',
  referenceWhiteNits: 203,
  peakLuminanceNits: 1000,
})
export function validColorSettings(v: ColorSettings) {
  return (
    !!v &&
    colorSpaces.includes(v.documentSpace) &&
    Number.isFinite(v.referenceWhiteNits) &&
    v.referenceWhiteNits >= 1 &&
    v.referenceWhiteNits <= 1000 &&
    Number.isFinite(v.peakLuminanceNits) &&
    v.peakLuminanceNits >= v.referenceWhiteNits &&
    v.peakLuminanceNits <= 10000 &&
    1.2 + 0.42 * Math.log10(v.peakLuminanceNits / 1000) > 0 &&
    Object.keys(v).every((k) =>
      ['documentSpace', 'referenceWhiteNits', 'peakLuminanceNits'].includes(k),
    )
  )
}
// Transport/schema validation only. Rust owns all numeric color transforms and
// the definitive finite working-range check when the document is installed.
export function validColor(value: unknown, managed = false): boolean {
  if (typeof value !== 'string' || value.length > 256) return false
  if (/^#[0-9a-f]{6}$/i.test(value)) return true
  if (!value.startsWith('color(') || !value.endsWith(')')) return false
  const p = value.slice(6, -1).replaceAll('/', ' / ').trim().split(/\s+/)
  if (
    (p.length !== 4 && (p.length !== 6 || p[4] !== '/')) ||
    !colorSpaces.includes(p[0] as ColorSpace)
  )
    return false
  const numbers = [...p.slice(1, 4), ...(p.length === 6 ? [p[5]] : [])]
  if (
    !numbers.every(
      (v) =>
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) &&
        Number.isFinite(Number(v)) &&
        Math.abs(Number(v)) <= 65504,
    )
  )
    return false
  if (p.length === 6 && !(Number(p[5]) >= 0 && Number(p[5]) <= 1)) return false
  // Unmanaged SDR may carry explicit sRGB alpha without changing the entire
  // document to linear-light compositing. Other spaces still require management.
  if (!managed) return p[0] === 'srgb' && p.slice(1, 4).every(v => Number(v) >= 0 && Number(v) <= 1)
  return (
    !['rec2100-pq', 'rec2100-hlg'].includes(p[0]) ||
    p.slice(1, 4).every((v) => Number(v) >= 0 && Number(v) <= 1)
  )
}

/** Opaque sRGB and #rrggbb for the inspector swatch. Other spaces stay stored as-is. */
export function displayColorHex(value: string): string | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return `#${hex[1].toUpperCase()}`
  const match = /^color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\s*\)$/i.exec(value)
  if (!match) return null
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  if (!(alpha >= 0.999)) return null
  const channels = [match[1], match[2], match[3]].map(Number)
  if (channels.some(n => !Number.isFinite(n) || n < 0 || n > 1)) return null
  const byte = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase()
  return `#${channels.map(byte).join('')}`
}
