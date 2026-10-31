import path from 'node:path'
import { DOCUMENT_BYTE_LIMIT } from './document-capacity.mjs'
import { realpath } from 'node:fs/promises'

export const APP_URL = 'design-app://app/index.html'
export const MAX_DOCUMENT_BYTES = DOCUMENT_BYTE_LIMIT
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function isAppResource(value) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'design-app:' &&
      url.hostname === 'app' &&
      !url.port &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export function assertSender(event, window) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== APP_URL
  ) {
    throw new Error('Untrusted desktop IPC sender')
  }
}

export async function resourcePath(root, value) {
  if (!isAppResource(value)) throw new Error('Invalid resource origin')
  const url = new URL(value)
  let name = decodeURIComponent(url.pathname)
  if (name === '/') name = '/index.html'
  if (name.includes('\\') || name.includes('\0') || name.split('/').includes('..')) {
    throw new Error('Invalid resource path')
  }
  const rootPath = await realpath(root)
  const candidate = await realpath(path.resolve(rootPath, `.${name}`))
  const relative = path.relative(rootPath, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Resource outside renderer bundle')
  }
  return candidate
}

export function record(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid desktop request')
  return value
}

export function documentFromString(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document exceeds the available document working-memory allowance')
  }
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid document')
  return parsed
}

export function validHandle(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)
}

export function resultError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INVALID_REQUEST'
  const messages = {
    WORKSPACE_CONFLICT: '本机库中的文档已有新版本。请重新打开或保存副本，当前修改已保留。',
    WORKSPACE_MUTATION_CONFLICT: '保存请求标识与内容不一致，已拒绝覆盖本机数据。',
    WORKSPACE_UNAVAILABLE: '本机文档库不可用，当前画布已保留，可另存为便携文件。',
    WORKSPACE_NOT_FOUND: '本机文档或版本不存在。',
    WORKSPACE_INVALID: '本机文档库无法读取，原数据库已保留。',
    WORKSPACE_FUTURE_VERSION: '本机文档库来自更新的应用版本，原数据库已保留。',
    WORKSPACE_LIMIT: '本机文档库已达到容量限制，请备份并整理文档。',
    CLIPBOARD_TOO_LARGE: '剪贴板内容超过可导入大小，未修改当前文档。',

    DIRECTORY_LIMIT: 'The active folder must remain available. Close its document before selecting another folder.',
    STALE_DIRECTORY: 'This folder is no longer authorized or has changed. Select it again using the native folder dialog.',
    DIRECTORY_RESELECT: 'This folder is no longer authorized or has changed. Select it again using the native folder dialog.',
    CATALOG_INVALID: 'The local project catalog could not be read. Your design files have been preserved.',
    CONFLICT:
      'The file changed outside this window. Open it again or use Save As to keep both versions.',
    BACKEND_UNAVAILABLE:
      'The local Rust backend is unavailable. Your canvas remains open; restart the app to recover the last snapshot.',
    BACKEND_TIMEOUT:
      'The local backend did not finish in time. Verify the file before trying again.',
    INVALID_DOCUMENT: 'The file is not a supported, valid futureox-desgin document.',
    DOCUMENT_RESOURCE_LIMIT: 'This document needs more working memory than this session can safely admit. Stored bytes and the current canvas are preserved.',
    DOCUMENT_TOO_LARGE: 'This document exceeds the current working-memory allowance. Stored bytes and the current canvas are preserved.',
    TOO_LARGE: 'The document exceeds the available working-memory allowance. Close other documents or use a machine with more memory.',
    RECOVERY_LIMIT:
      'The recovery store is full. Recover and save an earlier snapshot to free space, or save this design manually.',
    BUSY: 'Another file operation is in progress. Please try again after it finishes.',
  }
  return {
    status: code === 'CONFLICT' || code === 'WORKSPACE_CONFLICT' ? 'conflict' : 'error',
    code,
    message:
      (error?.outcomeUnknown ? 'The backend stopped before confirming this change. It may have been applied. Verify the file or session state before trying again.' : messages[code]) ||
      (code === 'LARGE_DOCUMENT_ERROR' && typeof error?.message === 'string' ? `大型文档：${error.message.slice(0, 512)}` : 'The local file operation failed. The current canvas has been preserved.'),
  }
}
