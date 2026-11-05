/** 插件包加载：本地 zip、目录选择与 GitHub 仓库地址。
 *
 * 只做文件获取与 manifest 校验；代码执行由 host 的沙箱 iframe 负责。
 * 网络仅 GitHub API zipball（CORS 允许、未认证 60 次/小时），不执行任何
 * 插件提供的网络请求（P0 容器不实现 networkAccess 代理）。
 */
import { unzipSync } from 'fflate'
import { bundleFromFiles, type PluginBundle } from './host'

const MAX_ZIP_BYTES = 32 * 1024 * 1024

function decodeText(bytes: Uint8Array, label: string, maxBytes: number): string {
  if (bytes.byteLength > maxBytes) throw new Error(`${label} 超过大小限制`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} 不是 UTF-8 文本`)
  }
}

/** 从 zip 字节解出插件包；manifest 可位于根或唯一子目录。
 *  GitHub zipball 等单根目录压缩包会先剥去根前缀；subdir 非空时再按
 *  剥根后的 `{subdir}/` 前缀过滤。 */
export function loadPluginFromZipBytes(bytes: Uint8Array, origin: string, subdir?: string): PluginBundle {
  if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error('插件包超过 32 MiB')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    throw new Error(`插件 zip 解压失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const names = Object.keys(entries).filter(path =>
    !path.endsWith('/') && !path.includes('__MACOSX/') && !/(^|\/)\._/.test(path))
  // 单根目录（如 GitHub 的 `{repo}-{sha}/`）：剥去根前缀。
  let shouldStrip = false
  if (names.length && names.every(path => path.includes('/'))) {
    const firstRoot = names[0].split('/')[0]
    shouldStrip = names.every(path => path.split('/')[0] === firstRoot)
  }
  const rewritten: Record<string, Uint8Array> = {}
  for (const path of names) {
    const relative = shouldStrip ? path.slice(path.indexOf('/') + 1) : path
    if (relative) rewritten[relative] = entries[path]
  }
  const prefix = subdir ? subdir.replace(/^\/|\/$/g, '') + '/' : ''
  const files: Record<string, string> = {}
  for (const [path, data] of Object.entries(rewritten)) {
    if (prefix && !path.startsWith(prefix)) continue
    const relative = prefix ? path.slice(prefix.length) : path
    if (relative) files[relative] = decodeText(data, path, 4 * 1024 * 1024)
  }
  if (prefix && !Object.keys(files).length) throw new Error(`zip 中不存在目录：${subdir}`)
  return bundleFromFiles(files, origin)
}

/** 从 input[type=file]（含 webkitdirectory）读取插件包。 */
export async function loadPluginFromFileList(fileList: FileList | File[], origin: string): Promise<PluginBundle> {
  const files: Record<string, string> = {}
  for (const file of Array.from(fileList)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    if (relative.includes('__MACOSX/') || /(^|\/)\._/.test(relative)) continue
    if (file.size > 4 * 1024 * 1024) continue
    files[relative] = await file.text()
  }
  return bundleFromFiles(files, origin)
}

export interface GitHubTarget {
  owner: string
  repo: string
  ref?: string
  subdir?: string
}

/** 解析 GitHub 仓库地址：https 链接或 owner/repo 简写，均可带
 *  /tree/{ref}/{dir} 子目录。 */
export function parseGitHubUrl(input: string): GitHubTarget {
  const value = input.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(?:www\.)?github\.com\//i, '')
    .replace(/\/$/, '')
  if (!value.length) throw new Error('请输入插件仓库地址')
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)((?:\/[^/]+)*))?$/)
  if (!match) throw new Error('无法识别的 GitHub 地址；支持 https://github.com/owner/repo[/tree/branch/dir] 或 owner/repo')
  const [, owner, repo, ref, path] = match
  return { owner, repo, ref: ref || undefined, subdir: path ? path.replace(/^\//, '') : undefined }
}

/** 从 GitHub 下载仓库 zip 并定位插件目录。 */
export async function loadPluginFromGitHub(input: string, fetchImpl: typeof fetch = fetch): Promise<PluginBundle> {
  const target = parseGitHubUrl(input)
  const url = target.ref
    ? `https://api.github.com/repos/${target.owner}/${target.repo}/zipball/${encodeURIComponent(target.ref)}`
    : `https://api.github.com/repos/${target.owner}/${target.repo}/zipball`
  const response = await fetchImpl(url, { headers: { accept: 'application/zip' } })
  if (!response.ok) {
    if (response.status === 404) throw new Error('GitHub 仓库或分支不存在（404）')
    if (response.status === 403) throw new Error('GitHub API 限流（未认证 60 次/小时），请稍后再试')
    throw new Error(`GitHub 下载失败：HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return loadPluginFromZipBytes(
    bytes,
    `github:${target.owner}/${target.repo}${target.ref ? `@${target.ref}` : ''}${target.subdir ? `/${target.subdir}` : ''}`,
    target.subdir,
  )
}

/** 通用插件地址：http(s) 直链 .zip 或 GitHub 仓库地址。 */
export async function loadPluginFromAddress(input: string, fetchImpl: typeof fetch = fetch): Promise<PluginBundle> {
  if (/^https?:\/\//i.test(input) && /\.zip(?:[?#]|$)/i.test(input)) {
    const response = await fetchImpl(input)
    if (!response.ok) throw new Error(`插件下载失败：HTTP ${response.status}`)
    return loadPluginFromZipBytes(new Uint8Array(await response.arrayBuffer()), input)
  }
  return loadPluginFromGitHub(input, fetchImpl)
}
