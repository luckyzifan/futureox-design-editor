/** Plugin UI document policy. Inline scripts are the plugin's own UI.
 * connect-src none blocks fetch. The iframe is also sandboxed without allow-same-origin. */
export const PLUGIN_UI_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** Wrap a plugin UI fragment so the iframe has its own connect-src none policy.
 * A full HTML document keeps its structure and gains the same meta element. */
export function pluginUiSrcdoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_UI_CSP}">`
  if (/<!doctype html|<html[\s>]/i.test(html)) {
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, match => `${match}${meta}`)
    return html.replace(/<html[^>]*>/i, match => `${match}<head><meta charset="utf-8">${meta}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${html}</body></html>`
}

/** Message shape the plugin UI iframe already uses: parent.postMessage({ pluginMessage }, '*'). */
export function pluginUiMessage(pluginId: string, pluginMessage: unknown) {
  return { pluginMessage, pluginId }
}

export type PluginEditorSnapshot = { pageId: string; selection: string; revision: number }

/** Editor changes outside the plugin. documentchange carries an empty change list: it means the document revision moved. */
export function pluginEditorEvents(
  previous: PluginEditorSnapshot,
  next: PluginEditorSnapshot,
  applying: boolean,
): Array<'documentchange' | 'currentpagechange' | 'selectionchange'> {
  if (applying) return []
  const events: Array<'documentchange' | 'currentpagechange' | 'selectionchange'> = []
  if (previous.revision !== next.revision) events.push('documentchange')
  if (previous.pageId !== next.pageId) events.push('currentpagechange')
  if (previous.selection !== next.selection) events.push('selectionchange')
  return events
}
