import { PluginApiError } from './errors'
import { pluginLimits } from './limits'

export type PluginUiOptions = { width: number; height: number; title?: string; html: string }

export function readPluginUiOptions(html: unknown, options: unknown, fallbackHtml = ''): PluginUiOptions {
  const source = typeof html === 'string' && html.length ? html : fallbackHtml
  if (source.length > pluginLimits.htmlCharacters) throw new PluginApiError('ui', 'Plugin UI HTML exceeds 200000 characters')
  const record = options && typeof options === 'object' ? options as Record<string, unknown> : {}
  return {
    html: source,
    width: clampDimension(record.width, pluginLimits.uiWidth),
    height: clampDimension(record.height, pluginLimits.uiHeight),
    title: typeof record.title === 'string' ? record.title.slice(0, 80) : undefined,
  }
}

export function wrapPluginUi(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">`
  return `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${html}</body></html>`
}

export function readPluginMessage(data: unknown): { pluginMessage: unknown } | undefined {
  if (!data || typeof data !== 'object' || !('pluginMessage' in data)) return undefined
  const message = (data as { pluginMessage: unknown }).pluginMessage
  const encoded = JSON.stringify(message)
  if (encoded === undefined || encoded.length > pluginLimits.messageBytes) {
    throw new PluginApiError('ui', 'Plugin messages must be JSON and at most 64 KiB')
  }
  return { pluginMessage: JSON.parse(encoded) as unknown }
}

function clampDimension(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  const number = typeof value === 'number' ? value : bounds.fallback
  if (!Number.isFinite(number)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(number)))
}
