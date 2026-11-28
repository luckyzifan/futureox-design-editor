import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

export type PluginCommand = { name: string; command: string }
/** Figma launch contexts this host can provide. `codegen` renders the code section. */
export type PluginLaunchMode = 'default' | 'inspect' | 'codegen'
export type PluginEditorType = 'figma' | 'figjam' | 'dev' | 'slides' | 'buzz'

const EDITOR_TYPES: readonly PluginEditorType[] = ['figma', 'figjam', 'dev', 'slides', 'buzz']
const CAPABILITIES = new Set(['textreview', 'codegen', 'inspect', 'vscode'])

export function pluginEditorType(mode: PluginLaunchMode): PluginEditorType {
  return mode === 'inspect' || mode === 'codegen' ? 'dev' : 'figma'
}
const LOCAL_FOLDER_ID_PREFIX = 'futureox.local.folder:'

export type PluginCodegenLanguage = { label: string; value: string }
/** One quick-action parameter declared by the manifest. The host has no prompt; values may come from a launcher. */
export type PluginParameter = { name: string; key: string; description?: string; type: 'string' | 'boolean' }
export type PluginManifest = {
  name: string
  id: string
  api: '1.0.0'
  main: string
  ui: string | null
  uiFiles?: Readonly<Record<string, string>>
  editorType: PluginEditorType[]
  /** Capabilities from the manifest. `codegen` and `inspect` choose the Dev context. */
  capabilities: string[]
  /** Codegen languages from the manifest. The first value is the event language. */
  codegenLanguages: PluginCodegenLanguage[]
  /** Quick-action parameters from the manifest, validated but not prompted. */
  parameters: PluginParameter[]
  commands: PluginCommand[]
  /** True when the manifest asked for domains other than none. Fetch is limited to these origins. */
  networkIgnored: boolean
  networkDomains: string[]
  uiNetworkDomains?: string[]
  /** Declared permissions are recorded and not granted. */
  permissionsIgnored: string[]
}

export type PluginBundle = {
  manifest: PluginManifest
  main: string
  ui: string | null
  uiFiles?: Readonly<Record<string, string>>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new PluginApiError('invalid_manifest', `${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f]/.test(trimmed))
    throw new PluginApiError('invalid_manifest', `${label} must be 1–${max} characters without control characters`)
  return trimmed
}

/** Relative file inside the plugin folder. `..`, absolute paths, and empty segments reject. */
function pluginRelativeFile(value: unknown): string {
  const path = text(value, 'path', 180)
  if (path.includes('\\') || path.startsWith('/') || path.includes(':'))
    throw new PluginApiError('invalid_manifest', 'Plugin files must be relative paths inside the plugin folder')
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..'))
    throw new PluginApiError('invalid_manifest', 'Plugin files cannot climb out of the plugin folder')
  return path
}
export function pluginRelativePath(value: unknown, extension: string): string {
  const path = pluginRelativeFile(value)
  if (!path.endsWith(extension))
    throw new PluginApiError('invalid_manifest', `Plugin file must end with ${extension}`)
  return path
}
/** A manifest main entry: built JavaScript, or TypeScript the desktop host can strip. */
export function pluginEntryPath(value: unknown): string {
  const path = pluginRelativeFile(value)
  if (!/\.(?:m?js|tsx?)$/.test(path))
    throw new PluginApiError('invalid_manifest', 'Plugin main must end with .js, .mjs, .ts, or .tsx')
  return path
}

type EntryKind = 'javascript' | 'typescript' | 'tsx'
function entryKind(path: string): EntryKind {
  return path.endsWith('.ts') ? 'typescript' : path.endsWith('.tsx') ? 'tsx' : 'javascript'
}
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.(?:m?js|tsx?)$/, '')
}
function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index + 1)
}
/** Bounded fallback list for an unbuilt sample whose declared main and UI are absent. */
export function pluginEntrySourcePaths(main: string): string[] {
  if (entryKind(main) !== 'javascript') return [main]
  const stem = stemOf(main), dir = dirOf(main)
  const paths = [`${dir}${stem}.ts`, `${dir}${stem}.tsx`]
  if (dir) paths.push(`${stem}.ts`, `${stem}.tsx`)
  for (const source of ['src/', 'plugin-src/', 'source/']) {
    paths.push(`${source}${stem}.ts`, `${source}${stem}.tsx`, `${source}${stem}.js`)
  }
  return [...new Set(paths)]
}
export function pluginUiSourcePaths(ui: string): string[] {
  const base = ui.slice(ui.lastIndexOf('/') + 1)
  const paths = [ui]
  if (dirOf(ui)) paths.push(base)
  for (const source of ['src/', 'ui-src/', 'plugin-src/', 'source/']) paths.push(`${source}${base}`)
  return [...new Set(paths)]
}
export function pluginEntryFlavor(path: string): EntryKind {
  return entryKind(path)
}

function domainList(value: unknown, label: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 200))
    throw new PluginApiError('invalid_manifest', `${label} must be an array of strings`)
  return value.filter(item => item !== 'none')
}

function menuCommands(value: unknown, into: PluginCommand[], depth: number) {
  if (value === undefined) return
  if (!Array.isArray(value) || depth > 3)
    throw new PluginApiError('invalid_manifest', 'menu must be an array')
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new PluginApiError('invalid_manifest', 'menu items must be objects')
    const entry = item as Record<string, unknown>
    if (entry.separator === true) continue
    if (entry.menu !== undefined) menuCommands(entry.menu, into, depth + 1)
    if (entry.command !== undefined || (entry.name !== undefined && entry.menu === undefined)) {
      if (entry.command === undefined) continue
      into.push({ name: text(entry.name, 'menu name', 80), command: text(entry.command, 'command', 80) })
    }
    if (into.length > 40) throw new PluginApiError('invalid_manifest', 'menu can list at most 40 commands')
  }
}

function editorTypeList(value: unknown): PluginEditorType[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string'))
    throw new PluginApiError('invalid_manifest', 'editorType must be a non-empty array of strings')
  for (const item of value) {
    if (!EDITOR_TYPES.includes(item as PluginEditorType))
      throw new PluginApiError('invalid_manifest', `editorType ${item} is not one of ${EDITOR_TYPES.join(', ')}`)
  }
  if (value.includes('figjam') && value.includes('dev'))
    throw new PluginApiError('invalid_manifest', 'Figma does not support a manifest that lists editorType figjam and dev together')
  return [...value] as PluginEditorType[]
}

function capabilityList(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== 'string'))
    throw new PluginApiError('invalid_manifest', 'capabilities must be an array of strings')
  for (const item of value) {
    if (!CAPABILITIES.has(item)) throw new PluginApiError('invalid_manifest', `capability ${item} is not a Figma capability`)
  }
  return [...value] as string[]
}

function codegenLanguageList(value: unknown, capabilities: string[]): PluginCodegenLanguage[] {
  if (value === undefined) {
    if (capabilities.includes('codegen'))
      throw new PluginApiError('invalid_manifest', 'A codegen plugin must declare codegenLanguages')
    return []
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    throw new PluginApiError('invalid_manifest', `codegenLanguages must list 1–16 languages`)
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new PluginApiError('invalid_manifest', 'codegenLanguages entries must be objects')
    const entry = item as Record<string, unknown>
    const label = text(entry.label, 'codegen language label', 80)
    const code = text(entry.value, 'codegen language value', 80)
    if (seen.has(code)) throw new PluginApiError('invalid_manifest', 'codegenLanguages must not repeat a value')
    seen.add(code)
    return { label, value: code }
  })
}

function parameterList(value: unknown): PluginParameter[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16)
    throw new PluginApiError('invalid_manifest', 'parameters must be an array of at most 16 entries')
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new PluginApiError('invalid_manifest', 'parameter entries must be objects')
    const entry = item as Record<string, unknown>
    const name = text(entry.name, 'parameter name', 80)
    const key = text(entry.key, 'parameter key', 80)
    if (seen.has(key)) throw new PluginApiError('invalid_manifest', 'parameters must not repeat a key')
    seen.add(key)
    const description = entry.description === undefined ? undefined : text(entry.description, 'parameter description', 500)
    const type = entry.type === undefined ? 'string' : entry.type
    if (type !== 'string' && type !== 'boolean')
      throw new PluginApiError('invalid_manifest', 'parameter type must be string or boolean')
    return { name, key, ...(description === undefined ? {} : { description }), type }
  })
}

function namedUiFiles(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > PLUGIN_LIMITS.uiFiles)
    throw new PluginApiError('invalid_manifest', `ui must declare 1–${PLUGIN_LIMITS.uiFiles} files`)
  return Object.fromEntries(entries.map(([name, file]) => {
    if (text(name, 'UI name', 80) !== name) throw new PluginApiError('invalid_manifest', 'UI names must not have surrounding whitespace')
    return [name, pluginRelativePath(file, '.html')]
  }))
}

/** Parse a Figma-style manifest. Network and permissions are not granted; the plugin can still load. */
export function parsePluginManifest(value: unknown, { desktopFolder = false } = {}): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PluginApiError('invalid_manifest', 'manifest.json must be an object')
  const record = value as Record<string, unknown>
  const name = text(record.name, 'name', 80)
  const id = typeof record.id === 'number' && Number.isSafeInteger(record.id) && record.id > 0
    ? String(record.id) : text(record.id, 'id', 128)
  if (id.startsWith(LOCAL_FOLDER_ID_PREFIX) && (!desktopFolder || !/^[0-9a-f]{64}$/.test(id.slice(LOCAL_FOLDER_ID_PREFIX.length))))
    throw new PluginApiError('invalid_manifest', 'This plugin id is reserved for an installed local folder')
  if (record.api !== '1.0.0') throw new PluginApiError('invalid_manifest', 'api must be "1.0.0"')
  const main = pluginEntryPath(record.main)
  const uiFiles = namedUiFiles(record.ui)
  const ui = uiFiles ? uiFiles.main ?? null : record.ui === undefined ? null : pluginRelativePath(record.ui, '.html')
  const editorType = record.editorType === undefined ? ['figma'] as PluginEditorType[] : editorTypeList(record.editorType)
  const capabilities = capabilityList(record.capabilities)
  const codegenLanguages = codegenLanguageList(record.codegenLanguages, capabilities)
  const parameters = parameterList(record.parameters)
  if (record.documentAccess !== undefined && typeof record.documentAccess !== 'string')
    throw new PluginApiError('invalid_manifest', 'documentAccess must be a string. The open document is already local.')
  let networkDomains: string[] = []
  let uiNetworkDomains: string[] = []
  const network = record.networkAccess
  if (network != null) {
    if (typeof network !== 'object' || Array.isArray(network))
      throw new PluginApiError('invalid_manifest', 'networkAccess must be an object')
    const access = network as Record<string, unknown>
    uiNetworkDomains = domainList(access.allowedDomains, 'allowedDomains')
    networkDomains = [...uiNetworkDomains, ...domainList(access.devAllowedDomains, 'devAllowedDomains')]
    if (networkDomains.length > 40) throw new PluginApiError('invalid_manifest', 'networkAccess lists too many domains')
    if (access.reasoning !== undefined && typeof access.reasoning !== 'string')
      throw new PluginApiError('invalid_manifest', 'networkAccess.reasoning must be a string')
  }
  const networkIgnored = networkDomains.length > 0
  let permissionsIgnored: string[] = []
  if (record.permissions !== undefined) {
    if (!Array.isArray(record.permissions) || record.permissions.some(item => typeof item !== 'string'))
      throw new PluginApiError('invalid_manifest', 'permissions must be an array of strings')
    permissionsIgnored = record.permissions
  }
  const commands: PluginCommand[] = []
  menuCommands(record.menu, commands, 0)
  return {
    name, id, api: '1.0.0', main, ui, ...(uiFiles ? { uiFiles } : {}), editorType, capabilities, codegenLanguages, parameters, commands,
    networkIgnored, networkDomains, permissionsIgnored,
    ...(uiNetworkDomains.length ? { uiNetworkDomains } : {}),
  }
}

export type PluginLaunchContext = { editorType: PluginEditorType; mode: PluginLaunchMode }

/**
 * Pick the Figma context for a launch. The editor's current context wins when the
 * manifest declares it; a design launch falls back to a Dev-only plugin's
 * inspection or codegen context. FigJam, Slides, and Buzz have no editor here,
 * so those manifests load but report a documented launch error.
 */
export function pluginLaunchContext(manifest: PluginManifest, preferred: PluginLaunchMode): PluginLaunchContext {
  if (preferred === 'codegen' && !manifest.capabilities.includes('codegen'))
    throw new PluginApiError('unsupported_codegen', 'This plugin does not declare the codegen capability')
  const wanted = pluginEditorType(preferred)
  if (manifest.editorType.includes(wanted)) {
    if (wanted === 'dev' && preferred === 'inspect' && !manifest.capabilities.includes('inspect') && manifest.capabilities.includes('codegen'))
      return { editorType: 'dev', mode: 'codegen' }
    return { editorType: wanted, mode: preferred }
  }
  if (wanted === 'dev')
    throw new PluginApiError('editor_type_unavailable', 'This plugin does not declare the Dev editor type')
  if (manifest.editorType.includes('figma')) return { editorType: 'figma', mode: 'default' }
  if (manifest.editorType.includes('dev')) {
    const mode = manifest.capabilities.includes('inspect') ? 'inspect'
      : manifest.capabilities.includes('codegen') ? 'codegen' : 'inspect'
    return { editorType: 'dev', mode }
  }
  const missing = manifest.editorType.filter(type => type !== 'figma' && type !== 'dev')
  throw new PluginApiError(
    'editor_type_unavailable',
    `This plugin declares editorType ${JSON.stringify(manifest.editorType)}. Futureox Design does not provide a ${missing.join(' or ')} editor.`,
  )
}

export function assertPluginSource(source: string, label: string, maxBytes: number) {
  if (typeof source !== 'string') throw new PluginApiError('invalid_plugin', `${label} must be text`)
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > maxBytes) throw new PluginApiError('plugin_too_large', `${label} is ${bytes} bytes; the limit is ${maxBytes}`)
  return bytes
}

export function assertPluginBundle(bundle: PluginBundle) {
  assertPluginSource(bundle.main, bundle.manifest.main, PLUGIN_LIMITS.mainBytes)
  const entries = Object.entries(bundle.manifest.uiFiles ?? {})
  const files = bundle.uiFiles ?? {}
  if (entries.length !== Object.keys(files).length || entries.some(([name]) => !Object.hasOwn(files, name)))
    throw new PluginApiError('invalid_plugin', 'Plugin UI files must match the manifest')
  if (entries.length === 0) {
    if (bundle.ui != null) assertPluginSource(bundle.ui, bundle.manifest.ui || 'ui.html', PLUGIN_LIMITS.uiBytes)
    return
  }
  if (bundle.ui !== (Object.hasOwn(files, 'main') ? files.main : null))
    throw new PluginApiError('invalid_plugin', 'Default plugin UI must match the manifest')
  let remaining = PLUGIN_LIMITS.uiBytes
  for (const [name, path] of entries) remaining -= assertPluginSource(files[name], path, remaining)
}

export function pluginUiPaths(manifest: PluginManifest) {
  if (manifest.uiFiles) return [...new Set(Object.values(manifest.uiFiles))]
  return manifest.ui ? [manifest.ui] : []
}

export function missingPluginSource(manifest: PluginManifest, path: string) {
  return new PluginApiError('invalid_plugin', path === manifest.main
    ? `Missing built plugin entry ${path}. Build the plugin to generate the JavaScript named by main.`
    : `Missing plugin UI file ${path}`)
}

/** A source entry exists, but this runtime has no type stripper (or the entry uses JSX). */
export function pluginSourceUnsupported(path: string, reason: 'compiler' | 'tsx') {
  return new PluginApiError('invalid_plugin', reason === 'tsx'
    ? `${path} contains TSX/JSX or another form the bounded type stripper cannot load. Build the plugin to generate the JavaScript named by main.`
    : `${path} is an uncompiled TypeScript entry. Open the plugin folder in the desktop app, which type-strips it inside QuickJS limits, or build the JavaScript named by main.`)
}

export function pluginBundleFromSources(manifest: PluginManifest, files: ReadonlyMap<string, string>): PluginBundle {
  const source = (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw missingPluginSource(manifest, path)
    return content
  }
  const uiFiles = manifest.uiFiles && Object.fromEntries(Object.entries(manifest.uiFiles).map(([name, path]) => [name, source(path)]))
  const bundle = {
    manifest,
    main: source(manifest.main),
    ui: manifest.ui ? source(manifest.ui) : null,
    ...(uiFiles ? { uiFiles } : {}),
  }
  assertPluginBundle(bundle)
  return bundle
}
