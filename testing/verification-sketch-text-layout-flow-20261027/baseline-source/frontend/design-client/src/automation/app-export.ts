import type { DesignDocument } from '../model'
import { assetReference, boundedInteger, type DesignAutomationWarning } from './context'
import { exportDesignCode, EXPORT_LIMITS } from './export'
import { APP_LIMITS, validateAppDefinition, type AppDefinition } from './app-export-schema'
import { startExportedApp, type AppRuntimeConfig } from './app-export-runtime'
import { AutomationError, type AutomationExtension } from './types'

export type AppExportOptions = { version: 1; pageId?: string; maxNodes?: number; app: AppDefinition }
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
type Semantic = { tag: 'form' | 'input' | 'button' | 'section'; attrs: string; suffix?: string }

/** Rewrite only the known div structure emitted by the static exporter. Authored
 * strings are already escaped; no user HTML is parsed or interpreted here. */
function semanticMarkup(html: string, specs: Map<string, Semantic>) {
  const stack: { tag: string; suffix: string }[] = []
  return html.replace(/<div\b[^>]*>|<\/div>/g, token => {
    if (token === '</div>') {
      const top = stack.pop()!
      return top.tag === 'input' ? top.suffix : `${top.suffix}</${top.tag}>`
    }
    const id = /\bid="([^"]+)"/.exec(token)?.[1]
    const spec = id ? specs.get(id) : undefined
    const tag = spec?.tag ?? (stack.some(item => item.tag === 'button') ? 'span' : 'div')
    stack.push({ tag, suffix: spec?.suffix ?? '' })
    let attrs = token.slice(4, -1)
    if (spec) attrs = attrs.replace(/\saria-label="[^"]*"/, '')
    return `<${tag}${attrs}${spec ? ` ${spec.attrs}` : ''}>`
  })
}

/** Read-only, deterministic app compiler. The closed declarative contract adds
 * explicit local behavior while leaving code.export's static CSP untouched. */
export function exportRunnableApp(document: DesignDocument, input: AppExportOptions) {
  if (!input || input.version !== 1) throw new AutomationError('invalid_params', 'app.export requires version: 1')
  if (Object.keys(input).some(key => !['version', 'pageId', 'maxNodes', 'app'].includes(key))) throw new AutomationError('invalid_params', 'app.export contains unsupported options')
  const pageId = input.pageId ?? document.pages[0]?.id
  const app = validateAppDefinition(document, pageId, input.app)
  const maxNodes = boundedInteger(input.maxNodes, 200, 1, EXPORT_LIMITS.nodes, 'maxNodes')
  const source = structuredClone(document)
  const warnings: DesignAutomationWarning[] = [{ code: 'LOCAL_DATA_ONLY', message: 'Executable routes, forms, state and CRUD use browser-local data only. No backend, authentication, cloud database, API integration, or production security model is generated.' }]
  // Offline apps intentionally omit external/local-path images and hyperlinks.
  // Only the static exporter's already-admitted raster data URLs are retained.
  for (const n of Object.values(source.nodes)) {
    for (const paint of [...n.fills, ...n.strokes.map(s => s.paint)]) if (paint.image && assetReference(paint.image, n.id, paint.id).source !== 'embedded') {
      delete paint.image; warnings.push({ code: 'OFFLINE_ASSET_OMITTED', nodeId: n.id, message: 'A non-embedded image was omitted. Embed a supported raster image in the authored document for offline use.' })
    }
    for (const run of n.textRuns ?? []) if (run.link) { delete run.link; warnings.push({ code: 'OFFLINE_LINK_OMITTED', nodeId: n.id, message: 'External text links are omitted from offline apps. Use an explicit local route action.' }) }
  }
  const nodeIdMap: Record<string, { elementId: string; selector: string }> = Object.create(null)
  const routeParts: { html: string; css: string }[] = [], assets: ReturnType<typeof exportDesignCode>['assets'] = []
  let nodeCount = 0, assetBytes = 0
  app.routes.forEach((route, index) => {
    const code = exportDesignCode(source, { pageId: route.pageId ?? pageId, nodeIds: [route.nodeId], maxNodes })
    nodeCount += Object.keys(code.nodeIdMap).length
    if (nodeCount > maxNodes) throw new AutomationError('invalid_params', 'app.export exceeds its total maxNodes budget across routes')
    const prefix = `app-route-${index + 1}-`
    for (const [id, map] of Object.entries(code.nodeIdMap)) {
      if (Object.hasOwn(nodeIdMap, id)) throw new AutomationError('invalid_params', 'Resolved route trees contain overlapping node IDs')
      nodeIdMap[id] = { elementId: prefix + map.elementId, selector: `#${prefix}${map.elementId}` }
    }
    for (const asset of code.assets) {
      const existing = asset.dataUrl && assets.find(a => a.dataUrl === asset.dataUrl)
      if (existing) {
        existing.nodeIds = [...new Set([...existing.nodeIds, ...asset.nodeIds])]
        existing.paintIds = [...new Set([...existing.paintIds, ...asset.paintIds])]
        continue
      }
      assetBytes += asset.dataUrl?.length ?? 0
      if (assetBytes > EXPORT_LIMITS.embeddedTotal) throw new AutomationError('invalid_params', 'app.export exceeds its total embedded image budget across routes')
      assets.push({ ...asset, id: prefix + asset.id, path: `assets/${prefix}${asset.path.slice('assets/'.length)}` })
    }
    for (const warning of code.warnings) if (!warnings.some(w => w.code === warning.code && w.nodeId === warning.nodeId)) warnings.push(warning.code === 'INTERACTIONS_NOT_EXPORTED' ? { ...warning, message: 'Native animation/prototype interactions are not automatically translated. Only the explicit app definition supplies executable behavior.' } : warning)
    const content = /<main class="design-scene">([\s\S]*)<\/main>/.exec(code.html)![1]
    const html = content.replace(/\b(id|class)="([^"]+)"/g, (_match, attr: string, value: string) => `${attr}="${value.replace(/\bdesign-node-\d+(?:-run-\d+)?\b/g, match => prefix + match)}"`)
    routeParts.push({ html, css: code.css.replace(/([#.])design-node-(\d+)/g, `$1${prefix}design-node-$2`).replace(/\.design-scene\b/g, `.${prefix}scene`) })
  })
  const semantic = new Map<string, Semantic>()
  const id = (nodeId: string) => {
    if (!nodeIdMap[nodeId]) throw new AutomationError('invalid_params', 'An authored behavior node is absent after component resolution; detach or bind a visible authored node')
    return nodeIdMap[nodeId].elementId
  }
  for (const a of app.actions) semantic.set(id(a.nodeId), { tag: 'button', attrs: `type="button" aria-label="${escape(a.label)}"` })
  for (const f of app.forms) {
    const errors = `${id(f.nodeId)}-errors`
    semantic.set(id(f.nodeId), { tag: 'form', attrs: `novalidate aria-label="${escape(f.id)}" aria-describedby="${errors}"`, suffix: `<p id="${errors}" class="app-form-errors" role="alert" aria-live="polite"></p>` })
    semantic.set(id(f.submitNodeId), { tag: 'button', attrs: `type="submit" aria-label="${escape(f.submitLabel)}"` })
    for (const field of f.fields) {
      const constraints = `${field.required ? ' required' : ''}${field.minLength === undefined ? '' : ` minlength="${field.minLength}"`}${['text', 'email'].includes(field.type) ? ` maxlength="${field.maxLength ?? APP_LIMITS.string}"` : ''}${field.min === undefined ? '' : ` min="${field.min}"`}${field.max === undefined ? '' : ` max="${field.max}"`}`
      semantic.set(id(field.nodeId), { tag: 'input', attrs: `type="${field.type}" name="${escape(field.name)}" aria-label="${escape(field.label)}" aria-describedby="${errors}"${field.type === 'number' ? ' step="any"' : ''}${constraints}` })
    }
  }
  for (const list of app.lists) semantic.set(id(list.nodeId), { tag: 'section', attrs: `class="app-collection" aria-label="${escape(list.label)}" tabindex="-1"` })
  // Text input/collection hosts must not retain source text outside void elements.
  const clearHosts = new Set([...app.forms.flatMap(f => f.fields.map(field => id(field.nodeId))), ...app.lists.map(list => id(list.nodeId))])
  const sections = routeParts.map((part, index) => {
    const route = app.routes[index], rootId = id(route.nodeId)
    let content = part.html
    for (const host of clearHosts) content = content.replace(new RegExp(`(<div id="${host}"[^>]*>)[\\s\\S]*?<\\/div>`, 'g'), '$1</div>')
    content = semanticMarkup(content, semantic)
    // Merge the collection class into the original class rather than duplicate it.
    content = content.replace(/class="([^"]*)"([^>]*?) class="app-collection"/g, 'class="$1 app-collection"$2')
    return `<section id="${rootId}-route" class="design-scene app-route-${index + 1}-scene" data-app-route="${escape(route.path)}" aria-label="${escape(route.title)}" tabindex="-1"${route.path === app.initialRoute ? '' : ' hidden'}>${content}</section>`
  }).join('\n')
  const storageKey = `futureox.app.v1:${encodeURIComponent(document.id)}:${app.id}`
  const runtime: AppRuntimeConfig = { version: 1, app, nodeIdMap, storageKey, storageSchema: JSON.stringify({ state: Object.fromEntries(Object.entries(app.state).map(([key, value]) => [key, typeof value])), collections: app.collections.map(c => ({ id: c.id, fields: c.fields })) }), title: document.name }
  const javascript = `/* Futureox offline app runtime v1. Generated trusted interpreter; configuration is data. */\n(${startExportedApp.toString()})(${safeJson(runtime)});\n`
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(document.name)}</title><link rel="stylesheet" href="styles.css"><script src="app.js" defer></script></head><body><p id="app-status" class="app-status" role="status" aria-live="polite"></p><noscript>This app needs JavaScript for routes, forms and local records.</noscript><main>${sections}</main></body></html>\n`
  const css = routeParts.map(part => part.css).join('\n') + `\n[hidden]{display:none!important}\nbutton,input{font:inherit;color:inherit}button{cursor:pointer}input{padding:8px}button:focus-visible,input:focus-visible,[tabindex]:focus-visible{outline:3px solid #245bea;outline-offset:3px}.app-status{position:relative;z-index:1;margin:0;padding:8px 16px;font:14px/1.5 system-ui;min-height:36px}.app-form-errors{position:absolute;top:100%;left:0;color:#a31515;font:14px/1.4 system-ui;margin:8px 0}.app-collection{overflow:auto!important}.app-records{list-style:none;padding:12px;margin:0;font:14px/1.5 system-ui}.app-records li{padding:12px;border-bottom:1px solid #d7dce5}.app-records dl{margin:0 0 8px;display:grid;grid-template-columns:minmax(70px,1fr) 3fr;gap:4px}.app-records dt{font-weight:600}.app-records dd{margin:0;overflow-wrap:anywhere}.app-records button{margin:0 8px 0 0;padding:6px 12px}.design-node[aria-invalid=true]{outline:2px solid #a31515}\n`
  const readme = `# ${document.name.replace(/[\r\n]/g, ' ')}\n\nOffline application export v1.\n\nOpen index.html with styles.css and app.js beside it. No build step, package install, network service or production backend is needed. app.json is the exact declarative specification plus source-node mapping used by this export. JavaScript is a trusted closed interpreter; user strings are never evaluated as code.\n\nBehavior: local hash routes (including Back/Forward), native keyboard-accessible buttons, semantic forms, required/email/length/number validation, local record create/read/edit/delete, typed state actions and localStorage persistence. Data is namespaced by document ID and app ID. Same-origin tabs share that namespace and the most recent save wins. Use a distinct app.id for independent stores.\n\nPersistence depends on browser permissions. file:// localStorage behavior varies by browser; if unavailable the status area explicitly reports tab-only changes. Storage failures are reported while the current tab remains usable. Invalid or incompatible stored data is rejected, and the next successful user change replaces it. No automatic schema migration, encryption, synchronization, login, authentication, or remote API is supplied. Do not use this local store for credentials or sensitive production records.\n\nOnly embedded supported raster images travel offline. External links/images are omitted with warnings. HTML/CSS remains an editable approximation of the design, using the existing layout/export path; fonts, native material effects and pixels are not asserted equivalent. Native prototype interactions are not automatically translated: only the explicit app definition runs. Node IDs map authored controls to semantic DOM elements; repeated local-data rows identify their authored host through data-source-node-id.\n\nLimits: ${APP_LIMITS.routes} routes, ${maxNodes} total resolved design nodes, ${APP_LIMITS.collections} collections, ${APP_LIMITS.records} records per collection, ${APP_LIMITS.fields} fields per collection, ${APP_LIMITS.string} characters per value, 256 KiB configuration, 2 MiB browser storage, 8 MiB total export response.\n`
  const result = { format: 'futureox.design-app.v1', runtimeVersion: 1, language: 'html-css-javascript', entrypoint: 'index.html', html, css, javascript, appJson: safeJson(runtime), readme, nodeIdMap, assets, warnings, fidelity: 'approximate', storage: 'localStorage-with-memory-fallback', sourceDocumentId: document.id, pageId, pageIds: [...new Set(app.routes.map(r => r.pageId ?? pageId))], sourceNodeCount: nodeCount }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > EXPORT_LIMITS.bytes) throw new AutomationError('response_limit', 'app.export exceeds the combined 8 MiB response budget')
  return result
}

const str = { type: 'string', minLength: 1, maxLength: 160 }
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
const arr = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems })
const scalar = { anyOf: [{ type: 'string', maxLength: 4096 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }
export const appExportExtensions: AutomationExtension[] = [{
  name: 'app.export', mutates: false,
  description: 'Compile version:1 explicit authored-node behavior into an offline HTML/CSS/JS app: multi-page local hash routes, typed state, semantic forms/validation and browser-local CRUD/persistence. No arbitrary scripts, network, authentication or backend. Separate from static code.export. Returns inert source assets and exact node mappings.',
  inputSchema: obj({ version: { type: 'integer', enum: [1] }, pageId: str, maxNodes: { type: 'integer', minimum: 1, maximum: 500 }, app: obj({
    id: str,
    routes: arr(obj({ path: str, nodeId: str, pageId: str, title: str }, ['path', 'nodeId', 'title']), 16), initialRoute: str,
    state: { type: 'object', additionalProperties: scalar },
    collections: arr(obj({ id: str, fields: arr(obj({ name: str, type: { type: 'string', enum: ['string', 'number', 'boolean'] } }, ['name', 'type']), 24), records: arr({ type: 'object', additionalProperties: scalar }, 500) }, ['id', 'fields']), 16),
    forms: arr(obj({ id: str, nodeId: str, collection: str, submitNodeId: str, submitLabel: str, successRoute: str, fields: arr(obj({ nodeId: str, name: str, label: str, type: { type: 'string', enum: ['text', 'email', 'number', 'checkbox'] }, required: { type: 'boolean' }, minLength: { type: 'integer', minimum: 0, maximum: 4096 }, maxLength: { type: 'integer', minimum: 0, maximum: 4096 }, min: { type: 'number' }, max: { type: 'number' } }, ['nodeId', 'name', 'label', 'type']), 24) }, ['id', 'nodeId', 'collection', 'submitNodeId', 'submitLabel', 'fields']), 32),
    actions: arr(obj({ nodeId: str, label: str, steps: arr({ anyOf: [obj({ kind: { enum: ['navigate'] }, to: str }, ['kind', 'to']), obj({ kind: { enum: ['state.set'] }, key: str, value: scalar }, ['kind', 'key', 'value']), obj({ kind: { enum: ['state.toggle'] }, key: str }, ['kind', 'key']), obj({ kind: { enum: ['form.reset'] }, form: str }, ['kind', 'form'])] }, 8) }, ['nodeId', 'label', 'steps']), 128),
    lists: arr(obj({ nodeId: str, collection: str, label: str, columns: arr(obj({ field: str, label: str }, ['field', 'label']), 24), editForm: str, editRoute: str, allowDelete: { type: 'boolean' }, emptyText: str }, ['nodeId', 'collection', 'label', 'columns']), 32),
    textBindings: arr(obj({ nodeId: str, state: str, collectionCount: str, prefix: { type: 'string', maxLength: 160 } }, ['nodeId']), 128),
  }, ['id', 'routes']) }, ['version', 'app']),
  execute: (document, params, context) => exportRunnableApp(document, { ...params, pageId: params.pageId ?? context.pageId } as AppExportOptions),
}]
