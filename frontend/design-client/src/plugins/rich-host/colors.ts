import { PluginApiError } from './errors'

export type FigmaRgb = { r: number; g: number; b: number; a?: number }

function channel(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new PluginApiError('invalid_value', `${name} must be a number from 0 to 1`)
  return Math.round(value * 255)
}

/** Figma RGB 0–1 to a document hex color. Alpha is returned separately. */
export function figmaColorToHex(color: unknown): { hex: string; alpha: number } {
  if (!color || typeof color !== 'object') throw new PluginApiError('invalid_value', 'Expected a color {r, g, b}')
  const record = color as Record<string, unknown>
  const red = channel(record.r, 'color.r')
  const green = channel(record.g, 'color.g')
  const blue = channel(record.b, 'color.b')
  const alpha = record.a === undefined ? 1 : channel(record.a, 'color.a') / 255
  const hex = `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`
  return { hex, alpha }
}

export function hexToFigmaColor(color: string): FigmaRgb {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return { r: 0, g: 0, b: 0, a: 1 }
  const value = Number.parseInt(match[1], 16)
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255, a: 1 }
}
