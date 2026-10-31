import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const WORKSPACE_DIRECTORY = '.futureox-workspace'
export const WORKSPACE_SELECTION = 'workspace-selection-v1.json'
const MARKER = 'workspace-root-v1.json'
const MAX_SELECTION_BYTES = 16 * 1024
const failure = (code = 'WORKSPACE_ROOT_INVALID') => Object.assign(new Error(code), { code })
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) })
const sameIdentity = (left, right) => ['dev', 'ino', 'birth'].every(key => left?.[key] === right?.[key])
const publicRoot = root => ({ displayName: root.kind === 'default' ? '原默认工作区' : path.basename(root.rootPath), isDefault: root.kind === 'default' })

async function directory(filename) {
  const stat = await lstat(filename, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(filename) !== filename) throw failure()
  return identity(stat)
}
async function regularFile(filename, optional = true) {
  try {
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure()
    return stat
  } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error }
}
async function smallJson(filename, optional = false) {
  const stat = await regularFile(filename, optional)
  if (!stat) return undefined
  if (stat.size > MAX_SELECTION_BYTES) throw failure()
  const fd = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const pinned = await fd.stat()
    if (pinned.dev !== stat.dev || pinned.ino !== stat.ino || pinned.size > MAX_SELECTION_BYTES) throw failure()
    const bytes = Buffer.alloc(MAX_SELECTION_BYTES + 1)
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_SELECTION_BYTES) throw failure()
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally { await fd.close() }
}
async function atomicJson(filename, value) {
  await regularFile(filename)
  const temporary = `${filename}.${randomUUID()}.tmp`
  let fd
  try {
    fd = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await fd.writeFile(`${JSON.stringify(value)}\n`); await fd.sync(); await fd.close(); fd = undefined
    await regularFile(filename)
    await rename(temporary, filename)
  } finally { await fd?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

export function workspaceRootError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'WORKSPACE_ROOT_INVALID'
  return { status: 'error', code, message: code === 'WORKSPACE_ROOT_PEERS'
    ? '请先关闭其他本机窗口，再切换工作区。'
    : code === 'WORKSPACE_ROOT_STALE' ? '所选目录已变化，请重新选择。当前工作区未切换。'
      : code === 'WORKSPACE_ROOT_RESTART' ? '无法重新启动。当前工作区已保留，请稍后重试。'
        : '无法打开所选本地工作区。请检查目录权限和数据库，原工作区与设计已保留。' }
}

/** Only the main process constructs roots. Renderer input is an opaque, expiring selection ID. */
export class WorkspaceRoots {
  constructor({ profileRoot, dialog, getWindow = () => undefined, probe = async () => {}, canSwitch = () => true }) {
    this.profileRoot = profileRoot
    this.dialog = dialog
    this.getWindow = getWindow
    this.probe = probe
    this.canSwitch = canSwitch
    this.pending = undefined
    this.current = undefined
  }
  async initialize() {
    await mkdir(this.profileRoot, { recursive: true, mode: 0o700 })
    this.profileRoot = await realpath(this.profileRoot)
    this.profileIdentity = await directory(this.profileRoot)
    this.selectionFile = path.join(this.profileRoot, WORKSPACE_SELECTION)
  }
  async verifyProfile() {
    if (!sameIdentity(this.profileIdentity, await directory(this.profileRoot))) throw failure('WORKSPACE_ROOT_STALE')
  }
  async prepare(selected, expected) {
    const kind = selected === undefined ? 'default' : 'directory'
    if (selected !== undefined && (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0'))) throw failure()
    const rootPath = selected === undefined ? this.profileRoot : await realpath(selected)
    // Choosing the original profile itself must reopen legacy data, never nest a new empty database.
    const actualKind = rootPath === this.profileRoot ? 'default' : kind
    const rootIdentity = await directory(rootPath)
    if (expected && (expected.rootPath !== rootPath || !sameIdentity(expected.rootIdentity, rootIdentity))) throw failure('WORKSPACE_ROOT_STALE')
    const storagePath = actualKind === 'default' ? rootPath : path.join(rootPath, WORKSPACE_DIRECTORY)
    if (actualKind !== 'default') {
      let created = false
      try { await mkdir(storagePath, { mode: 0o700 }); created = true }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      await directory(storagePath)
      const markerPath = path.join(storagePath, MARKER)
      if (created) {
        const fd = await open(markerPath, 'wx', 0o600)
        try { await fd.writeFile(JSON.stringify({ version: 1, application: 'futureox-workspace', id: randomUUID() })); await fd.sync() }
        finally { await fd.close() }
      }
      const marker = await smallJson(markerPath)
      if (marker?.version !== 1 || marker.application !== 'futureox-workspace' || typeof marker.id !== 'string' || !/^[0-9a-f-]{36}$/.test(marker.id)) throw failure()
    }
    const storageIdentity = await directory(storagePath)
    if (expected?.storageIdentity && !sameIdentity(expected.storageIdentity, storageIdentity)) throw failure('WORKSPACE_ROOT_STALE')
    const root = { kind: actualKind, rootPath, storagePath, rootIdentity, storageIdentity }
    await this.verify(root)
    // Probe only our new random file; never truncate or replace an existing user file.
    const writable = path.join(storagePath, `.workspace-write-check-${randomUUID()}`)
    const fd = await open(writable, 'wx', 0o600)
    try { await fd.writeFile('workspace write check'); await fd.sync() }
    finally { await fd.close(); await unlink(writable) }
    await mkdir(path.join(storagePath, 'recovery-v1'), { recursive: true, mode: 0o700 })
    await directory(path.join(storagePath, 'recovery-v1'))
    await this.verify(root)
    return root
  }
  async verify(root) {
    if (!sameIdentity(root.rootIdentity, await directory(root.rootPath)) || !sameIdentity(root.storageIdentity, await directory(root.storagePath))) throw failure('WORKSPACE_ROOT_STALE')
    for (const basename of ['workspace-v1.sqlite3', 'catalog-v1.sqlite3']) {
      const filename = path.join(root.storagePath, basename)
      const stat = await regularFile(filename)
      if (stat && stat.size) {
        const fd = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
        try {
          const header = Buffer.alloc(16)
          const { bytesRead } = await fd.read(header, 0, 16, 0)
          if (bytesRead !== 16 || header.toString('utf8') !== 'SQLite format 3\0') throw failure()
        } finally { await fd.close() }
      }
      for (const suffix of ['-wal', '-shm', '-journal']) await regularFile(`${filename}${suffix}`)
    }
    try { await directory(path.join(root.storagePath, 'recovery-v1')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return root
  }
  config(root) {
    return { recoveryDir: path.join(root.storagePath, 'recovery-v1'), catalogDb: path.join(root.storagePath, 'catalog-v1.sqlite3'), workspaceDb: path.join(root.storagePath, 'workspace-v1.sqlite3') }
  }
  async saved() {
    const saved = await smallJson(this.selectionFile, true)
    if (!saved) return undefined
    if (saved.version !== 1 || !['default', 'directory'].includes(saved.kind)) throw failure()
    if (saved.kind === 'directory' && (typeof saved.rootPath !== 'string' || !path.isAbsolute(saved.rootPath) || !saved.rootIdentity || !saved.storageIdentity)) throw failure()
    return saved
  }
  async persist(root) {
    await this.verifyProfile(); await this.verify(root)
    await atomicJson(this.selectionFile, { version: 1, kind: root.kind, ...(root.kind === 'directory' ? { rootPath: root.rootPath, rootIdentity: root.rootIdentity, storageIdentity: root.storageIdentity } : {}) })
  }
  async chooseDirectory() {
    const options = { title: '选择本地工作区目录（无需 Git 仓库）', properties: ['openDirectory', 'createDirectory'], buttonLabel: '使用此工作区' }
    const window = this.getWindow()
    const selection = await (window ? this.dialog.showOpenDialog(window, options) : this.dialog.showOpenDialog(options))
    return selection.canceled || selection.filePaths.length !== 1 ? undefined : selection.filePaths[0]
  }
  async startup({ isolated = false } = {}) {
    await this.initialize()
    if (isolated) { this.current = await this.prepare(); return this.current }
    let previous, warning = ''
    try { previous = await this.saved() } catch { warning = '上次工作区记录无法读取，请重新选择。原文件不会移动或删除。' }
    // A readable saved selection resumes directly instead of asking on every
    // launch. The picker still covers first run, unreadable records and failed
    // resumes (missing directory, probe failure); switching later keeps the
    // existing staged workspace command.
    if (!warning && previous) {
      try {
        const resumed = previous.kind === 'directory' ? await this.prepare(previous.rootPath, previous) : await this.prepare()
        await this.probe(this.config(resumed)); await this.verify(resumed)
        this.current = resumed
        return resumed
      } catch (error) { warning = workspaceRootError(error).message }
    }
    while (true) {
      const hasPrevious = previous?.kind === 'directory'
      const buttons = [...(hasPrevious ? ['继续上次工作区'] : []), '选择本地目录…', '打开原默认工作区', '退出']
      const answer = await this.dialog.showMessageBox({
        type: 'question', title: '选择本地工作区', message: '从哪个本地目录开始？',
        detail: warning || (hasPrevious ? `上次目录：${previous.rootPath}\n画布文件、版本和本地索引存储在所选目录的 ${WORKSPACE_DIRECTORY} 中。` : `工作区是本地目录，无需 Git。画布文件、版本和本地索引存储在目录的 ${WORKSPACE_DIRECTORY} 中。已有设计可从原默认工作区打开。`),
        buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true,
      })
      const choice = buttons[answer.response]
      if (!choice || choice === '退出') return undefined
      try {
        let root
        if (choice === '继续上次工作区') root = await this.prepare(previous.rootPath, previous)
        else if (choice === '打开原默认工作区') root = await this.prepare()
        else {
          const selected = await this.chooseDirectory()
          if (selected === undefined) continue
          root = await this.prepare(selected)
        }
        await this.probe(this.config(root)); await this.verify(root); await this.persist(root)
        this.current = root
        return root
      } catch (error) {
        warning = workspaceRootError(error).message
        await this.dialog.showMessageBox({ type: 'error', title: '工作区未打开', message: warning, buttons: ['重新选择'], noLink: true })
      }
    }
  }
  status() { return { status: 'ok', ...publicRoot(this.current), canSwitch: this.canSwitch() } }
  async stage(useDefault = false) {
    this.pending = undefined
    if (!this.canSwitch()) throw failure('WORKSPACE_ROOT_PEERS')
    const selected = useDefault ? undefined : await this.chooseDirectory()
    if (!useDefault && selected === undefined) return { status: 'cancelled' }
    const root = await this.prepare(selected)
    if (root.storagePath !== this.current.storagePath) await this.probe(this.config(root))
    await this.verify(root)
    const selectionId = randomUUID()
    this.pending = { selectionId, root, expires: Date.now() + 10 * 60_000 }
    return { status: 'ok', selectionId, ...publicRoot(root) }
  }
  async take(selectionId) {
    if (!this.canSwitch()) throw failure('WORKSPACE_ROOT_PEERS')
    const pending = this.pending
    this.pending = undefined
    if (typeof selectionId !== 'string' || selectionId !== pending?.selectionId || Date.now() > pending.expires) throw failure('WORKSPACE_ROOT_STALE')
    await this.verify(pending.root)
    return pending.root
  }
}
