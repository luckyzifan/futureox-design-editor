import { strToU8, zipSync } from 'fflate'
import { referenceHash } from './context'
import type { exportRunnableApp } from './app-export'

type AppBundle = ReturnType<typeof exportRunnableApp>

/** Browser-compatible save helper. Output files are fixed names; image paths are
 * validated before archive creation. Existing static-export helpers are separate. */
export function appExportZip(result: AppBundle): Uint8Array {
  if (result.format !== 'futureox.design-app.v1' || result.runtimeVersion !== 1) throw new Error('Unsupported app export version')
  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(result.html), 'styles.css': strToU8(result.css), 'app.js': strToU8(result.javascript),
    'app.json': strToU8(result.appJson), 'README.md': strToU8(result.readme),
    'design-manifest.json': strToU8(JSON.stringify({ ...result, html: undefined, css: undefined, javascript: undefined, appJson: undefined, readme: undefined, assets: result.assets.map(a => ({ ...a, dataUrl: undefined })) }, null, 2)),
  }
  for (const asset of result.assets) {
    if (!asset.emitted || !asset.dataUrl) continue
    if (!/^assets\/[A-Za-z0-9._-]+$/.test(asset.path)) throw new Error('Invalid app image path')
    const match = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(asset.dataUrl)
    if (!match) throw new Error('Invalid app image data')
    files[asset.path] = Uint8Array.from(atob(match[1].replace(/\s/g, '')), char => char.charCodeAt(0))
  }
  return zipSync(files, { mtime: new Date('1980-01-01T00:00:00Z') })
}

const integrity = (text: string) => `sha256-${btoa(String.fromCharCode(...referenceHash(text).match(/../g)!.map(value => parseInt(value, 16))))}`

/** The caller MUST apply the returned sandbox attribute, never allow-same-origin.
 * Exact source hashes allow this generated interpreter and stylesheet only. A
 * sandbox has an opaque origin, so persistence deliberately falls back to memory. */
export function sandboxedAppPreview(result: AppBundle): { srcDoc: string; sandbox: 'allow-scripts'; storage: 'memory-only-in-sandbox' } {
  if (result.format !== 'futureox.design-app.v1' || result.runtimeVersion !== 1) throw new Error('Unsupported app export version')
  const css = result.css.replace(/</g, '\\3c ')
  const javascript = result.javascript.replace(/<\/script/gi, '<\\/script')
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${integrity(javascript)}'; style-src '${integrity(css)}'; img-src data:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`
  const srcDoc = result.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/gi, '')
    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css}</style>`)
    .replace('<script src="app.js" defer></script>', () => `<script>${javascript}</script>`)
    .replace('<head>', () => `<head>${policy}`)
  return { srcDoc, sandbox: 'allow-scripts', storage: 'memory-only-in-sandbox' }
}
