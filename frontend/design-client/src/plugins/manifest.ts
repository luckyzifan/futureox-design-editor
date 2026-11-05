/** Figma 插件 manifest（manifestVersion 1/2）解析与校验。
 *
 * 这是本地插件容器的加载边界：manifest 描述插件的两个程序（沙箱 main 代码与
 * 可选 UI iframe 文档），容器只消费其中声明过的文件。本模块不做任何网络
 * 访问；文件内容由 loader 提供。
 *
 * P0 范围内 manifest 中与云端相关的字段（id 的社区唯一性、parameters、
 * capabilities 的后台含义）仅保留为元数据，不作为能力承诺。
 */

export interface PluginNetworkAccess {
  allowedDomains: string[]
  httpsAllowed: boolean
}

export interface PluginManifest {
  manifestVersion: 1 | 2
  name: string
  /** 社区插件 id；本地加载的插件可能没有。 */
  id?: string
  api?: string
  /** main 代码文件（沙箱内执行），相对 manifest 目录。 */
  main: string
  /** 可选 UI 文档，相对 manifest 目录。 */
  ui?: string
  version?: string
  editorType: ('figma' | 'figjam' | 'dev')[]
  documentAccess?: 'dynamic-page' | 'dynamic-document'
  networkAccess?: PluginNetworkAccess
  /** 其余字段按原样保留，供展示与后续扩展，不参与执行。 */
  raw: Record<string, unknown>
}

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginManifestError'
  }
}

const EDITOR_TYPES = ['figma', 'figjam', 'dev'] as const

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginManifestError('manifest 必须是 JSON 对象')
  return value as Record<string, unknown>
}

function asRelativeFile(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 512)
    throw new PluginManifestError(`${field} 必须是相对文件名`)
  // 相对路径限定在插件目录内；不接受绝对路径、盘符或目录穿越。
  if (value.includes('..') || value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value) || /^https?:/i.test(value))
    throw new PluginManifestError(`${field} 必须是插件目录内的相对路径`)
  return value
}

function parseNetworkAccess(value: unknown): PluginNetworkAccess {
  const record = asRecord(value)
  const domains = record.allowedDomains
  if (!Array.isArray(domains) || domains.length > 256 || domains.some(d => typeof d !== 'string' || !d.length || d.length > 512))
    throw new PluginManifestError('networkAccess.allowedDomains 必须是字符串数组')
  return { allowedDomains: domains as string[], httpsAllowed: record.httpsAllowed !== false }
}

/** 解析并校验一份 manifest.json 内容。manifestVersion 1/2；
 *  字段缺省时按 v1 处理（与 Figma 对存量插件的解释一致）。 */
function parseManifestObject(input: unknown): PluginManifest {
  const raw = asRecord(input)
  const version = raw.manifestVersion === undefined ? 1 : raw.manifestVersion
  if (version !== 1 && version !== 2)
    throw new PluginManifestError('manifestVersion 必须是 1 或 2')
  const name = raw.name
  if (typeof name !== 'string' || !name.trim().length || name.length > 256)
    throw new PluginManifestError('name 必须是非空字符串')
  const main = asRelativeFile(raw.main, 'main')
  let ui: string | undefined
  if (raw.ui !== undefined) {
    if (typeof raw.ui === 'string') ui = asRelativeFile(raw.ui, 'ui')
    else {
      // v1 允许 ui 为 {src, position}；容器只关心 src。
      const uiRecord = asRecord(raw.ui)
      ui = asRelativeFile(uiRecord.src, 'ui.src')
    }
  }
  let editorType: PluginManifest['editorType'] = ['figma']
  if (raw.editorType !== undefined) {
    if (!Array.isArray(raw.editorType) || !raw.editorType.length || raw.editorType.length > 8 ||
      raw.editorType.some((t: unknown) => typeof t !== 'string' || !(EDITOR_TYPES as readonly string[]).includes(t)))
      throw new PluginManifestError('editorType 必须是 figma/figjam/dev 的非空子集')
    editorType = raw.editorType as PluginManifest['editorType']
  }
  // figjam/dev 专用插件依赖 FigJam/Dev Mode 文档语义，本地容器只承载 figma 编辑器。
  if (!editorType.includes('figma'))
    throw new PluginManifestError('该插件不面向 figma 编辑器类型，本地容器暂不承载')
  if (version === 2 && raw.documentAccess !== undefined && raw.documentAccess !== 'dynamic-page' && raw.documentAccess !== 'dynamic-document')
    throw new PluginManifestError('documentAccess 仅支持 dynamic-page / dynamic-document')
  const manifest: PluginManifest = {
    manifestVersion: version,
    name,
    main,
    ...(ui === undefined ? {} : { ui }),
    editorType,
    ...(raw.id === undefined ? {} : typeof raw.id === 'string' && raw.id.length <= 256 ? { id: raw.id } : {}),
    ...(raw.api === undefined ? {} : typeof raw.api === 'string' && raw.api.length <= 64 ? { api: raw.api } : {}),
    ...(raw.version === undefined ? {} : typeof raw.version === 'string' && raw.version.length <= 128 ? { version: raw.version } : {}),
    ...(version === 2 && raw.documentAccess !== undefined ? { documentAccess: raw.documentAccess as PluginManifest['documentAccess'] } : {}),
    ...(raw.networkAccess === undefined ? {} : { networkAccess: parseNetworkAccess(raw.networkAccess) }),
    raw,
  }
  return manifest
}

import { PluginApiError } from './errors'

export type FilePluginManifest = {
  name: string
  id: string
  api: string
  main: string
  ui?: string
  editorType: string[]
}

const fileSuffixes = new Set(['js', 'mjs', 'html', 'json', 'css', 'svg'])

function requiredText(value: unknown, max: number, api: string) {
  if (typeof value !== 'string') throw new PluginApiError(api, 'invalid')
  const text = value.trim()
  if (!text || text.length > max) throw new PluginApiError(api, 'invalid')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PluginApiError(api, 'invalid')
  return text
}

/** Relative file inside the plugin folder. No absolute paths, empty segments, or parent segments. */
export function pluginRelativeFile(value: unknown, api: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new PluginApiError(api, 'invalid')
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) throw new PluginApiError(api, 'invalid')
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new PluginApiError(api, 'invalid')
  const suffix = parts.at(-1)?.split('.').pop()?.toLowerCase()
  if (!suffix || !fileSuffixes.has(suffix)) throw new PluginApiError(api, 'invalid')
  return value
}

function parseManifestText(text: string): { manifest: FilePluginManifest; warnings: string[] } {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 64 * 1024) throw new PluginApiError('manifest.json', 'invalid')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new PluginApiError('manifest.json', 'invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginApiError('manifest.json', 'invalid')
  const record = value as Record<string, unknown>
  const name = requiredText(record.name, 64, 'manifest.name')
  const id = requiredText(record.id, 128, 'manifest.id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new PluginApiError('manifest.id', 'invalid')
  const api = requiredText(record.api, 32, 'manifest.api')
  const main = pluginRelativeFile(record.main, 'manifest.main')
  const ui = record.ui === undefined ? undefined : pluginRelativeFile(record.ui, 'manifest.ui')
  const editorType = record.editorType === undefined ? ['figma'] : record.editorType
  if (!Array.isArray(editorType) || editorType.some(item => typeof item !== 'string') || !editorType.includes('figma')) {
    throw new PluginApiError('manifest.editorType', 'unsupported')
  }
  const warnings: string[] = []
  if (record.networkAccess) warnings.push('networkAccess is ignored. Plugins cannot use the network.')
  if (record.permissions) warnings.push('permissions are ignored. Plugins cannot grant capabilities.')
  if (record.documentAccess) warnings.push('documentAccess is ignored. The plugin sees one snapshot of the open document.')
  return {
    manifest: { name, id, api, main, ui, editorType: editorType.filter((item): item is string => typeof item === 'string') },
    warnings,
  }
}

export function parsePluginManifest(input: string): {manifest: FilePluginManifest; warnings: string[]}
export function parsePluginManifest(input: unknown): PluginManifest
export function parsePluginManifest(input: unknown) {
  return typeof input === 'string' ? parseManifestText(input) : parseManifestObject(input)
}
