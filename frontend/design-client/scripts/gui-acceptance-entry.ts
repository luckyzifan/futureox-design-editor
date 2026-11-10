/** Home, workspace-save, and isolated-snapshot entry for the GUI acceptance commands.
 * The visible sentence is checked together with the IndexedDB session, revision
 * snapshot, and the presented frame. Click options never include force. */
import { expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, stat, symlink } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  CURRENT_WORKSPACE_SAVE_LABEL,
  REQUIRED_SNAPSHOT_IMPORTS,
  acceptanceCounts,
  snapshotImportPath,
  spawnOwned,
  stopOwnedProcess,
} from './gui-acceptance-layout.mjs'

export { CURRENT_WORKSPACE_SAVE_LABEL, acceptanceCounts, stopOwnedProcess }

export type OwnedWorkspace = {
  command: string
  mode: 'new' | 'resume'
  documentId: string
  documentName: string
  revision: number
  updatedAt: number
  sessionId: string
  displayedDocumentId: string
  requestedDocumentId: string
  presentationReady: true
  frameVisible: true
  uiMode: 'figma' | 'sketch'
  shortcutProfile: 'figma-like' | 'sketch-like'
  saveLabel: typeof CURRENT_WORKSPACE_SAVE_LABEL
}

type WorkspaceProbe = {
  ok: boolean
  reason?: string
  documentId?: string
  documentName?: string
  revision?: number
  updatedAt?: number
  sessionId?: string
  displayedDocumentId?: string
  requestedDocumentId?: string
  presentationReady?: string | null
  frameVisible?: boolean
  uiMode?: string
  shortcutProfile?: string
  saveLabel?: string
}

/** Optional second layout. Unset keeps the product default and does not rewrite preferences. */
export async function installGuiLayoutPreference(page: Page) {
  const layout = process.env.DESIGN_GUI_LAYOUT
  if (layout !== 'figma' && layout !== 'sketch') return
  await page.addInitScript((mode: 'figma' | 'sketch') => {
    const prefsKey = 'forma.interface-preferences.v1'
    let prefs: Record<string, unknown> = {}
    try { prefs = JSON.parse(localStorage.getItem(prefsKey) || '{}') } catch { prefs = {} }
    prefs.uiMode = mode
    localStorage.setItem(prefsKey, JSON.stringify(prefs))
    localStorage.setItem('forma.shortcut-profile.v1', mode === 'sketch' ? 'sketch-like' : 'figma-like')
  }, layout)
}

async function probeWorkspace(page: Page, label: string): Promise<WorkspaceProbe> {
  return page.evaluate(async (expectedLabel) => {
    try {
      const { localOpen, localRequest, localTransaction } = await import('/src/local-store.ts')
      const record = await localOpen()
      if (!record) return { ok: false, reason: 'no-local-record' }
      const stored = await localTransaction(['session', 'revisions'], 'readonly', async (tx: IDBTransaction) => {
        const current = await localRequest<string | undefined>(tx.objectStore('session').get('current'))
        const snapshot = await localRequest(tx.objectStore('revisions').get([record.document.id, record.revision]))
        return { current, hasRevision: !!snapshot }
      })
      const surface = document.querySelector('.kernel-presentation')
      const shell = document.querySelector('.editor-shell')
      const title = document.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')?.value
      const saveLabel = document.querySelector('.save-status')?.textContent?.replace(/\s+/g, '') || ''
      const uiMode = shell?.getAttribute('data-ui-mode') || ''
      const storedProfile = localStorage.getItem('forma.shortcut-profile.v1')
      const shortcutProfile = storedProfile === 'sketch-like' || storedProfile === 'figma-like' ? storedProfile : 'figma-like'
      const expectedProfile = uiMode === 'sketch' ? 'sketch-like' : uiMode === 'figma' ? 'figma-like' : ''
      const displayedDocumentId = surface?.getAttribute('data-displayed-document') || ''
      const requestedDocumentId = surface?.getAttribute('data-requested-document') || ''
      const presentationReady = surface?.getAttribute('data-presentation-ready')
      const frameVisible = !!document.querySelector('canvas[data-frame-visible="true"]')
      const ok = saveLabel === expectedLabel
        && stored.current === record.document.id
        && stored.hasRevision
        && Number.isSafeInteger(record.revision) && record.revision >= 1
        && Number.isFinite(record.updatedAt)
        && title === record.document.name
        && displayedDocumentId === record.document.id
        && requestedDocumentId === record.document.id
        && presentationReady === 'true'
        && frameVisible
        && shortcutProfile === expectedProfile
      return {
        ok, documentId: record.document.id, documentName: record.document.name, revision: record.revision,
        updatedAt: record.updatedAt, sessionId: stored.current, displayedDocumentId, requestedDocumentId,
        presentationReady, frameVisible, uiMode, shortcutProfile, saveLabel,
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }, label)
}

/** Reads the current autosave sentence only together with the stored session and presented frame. */
export async function readOwnedWorkspace(page: Page): Promise<OwnedWorkspace> {
  await expect(page.locator('.save-status')).toHaveText(CURRENT_WORKSPACE_SAVE_LABEL, { timeout: 45_000 })
  let last: WorkspaceProbe = { ok: false, reason: 'not-probed' }
  await expect.poll(async () => {
    last = await probeWorkspace(page, CURRENT_WORKSPACE_SAVE_LABEL)
    return last.ok
  }, { timeout: 60_000 }).toBe(true)
  if (!last.ok || !last.documentId || !last.sessionId || last.revision === undefined || last.updatedAt === undefined)
    throw new Error(`Workspace save was not bound to a stored session: ${last.reason || 'incomplete'}`)
  if (last.uiMode !== 'figma' && last.uiMode !== 'sketch') throw new Error(`Unexpected layout ${last.uiMode}`)
  if (last.shortcutProfile !== 'figma-like' && last.shortcutProfile !== 'sketch-like')
    throw new Error(`Unexpected shortcut profile ${last.shortcutProfile}`)
  return {
    command: '',
    mode: 'resume',
    documentId: last.documentId,
    documentName: last.documentName || '',
    revision: last.revision,
    updatedAt: last.updatedAt,
    sessionId: last.sessionId,
    displayedDocumentId: last.displayedDocumentId || '',
    requestedDocumentId: last.requestedDocumentId || '',
    presentationReady: true,
    frameVisible: true,
    uiMode: last.uiMode,
    shortcutProfile: last.shortcutProfile,
    saveLabel: CURRENT_WORKSPACE_SAVE_LABEL,
  }
}

/** Leaves the home screen through the real button, then binds document, session, revision, and frame. */
export async function enterOwnedEditor(page: Page, mode: 'new' | 'resume', command: string): Promise<OwnedWorkspace> {
  await expect(page.locator('.editor-shell')).toBeVisible({ timeout: 90_000 })
  const home = page.locator('.local-home')
  await expect.poll(async () => (await home.count()) > 0 || (await page.getByTestId('canvas').count()) > 0, { timeout: 90_000 }).toBe(true)
  if (await home.count()) {
    const button = mode === 'new'
      ? page.getByRole('button', { name: '新建设计', exact: true })
      : page.getByRole('button', { name: /继续编辑/ })
    await expect(button).toBeEnabled({ timeout: 90_000 })
    await button.click()
    await expect(home).toHaveCount(0, { timeout: 30_000 })
  }
  const workspace = await readOwnedWorkspace(page)
  const entry = { ...workspace, command, mode }
  console.log(`ACCEPTANCE_ENTRY ${JSON.stringify(entry)}`)
  return entry
}

export function spawnOwnedVite(cwd: string | URL): ChildProcess {
  return spawnOwned('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], { cwd })
}

async function sha256(file: string) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** Copies the client with the repository's relative config, plugin, MCP, and shader paths. */
export async function freezeAcceptanceSnapshot(project: string, output: string) {
  const clientRoot = join(output, 'frontend', 'design-client')
  await mkdir(clientRoot, { recursive: true })
  for (const name of ['src', 'public', 'plugins', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'scripts'])
    await cp(join(project, name), join(clientRoot, name), { recursive: true })
  await symlink(join(project, 'node_modules'), join(clientRoot, 'node_modules'), 'dir')
  await cp(join(project, '../design-desktop/src'), join(output, 'frontend/design-desktop/src'), { recursive: true })
  await cp(join(project, '../design-desktop/scripts'), join(output, 'frontend/design-desktop/scripts'), { recursive: true })
  await cp(join(project, '../design-mcp/src'), join(output, 'frontend/design-mcp/src'), { recursive: true })
  await cp(join(project, '../../design-studio/crates/design-kernel/shaders'), join(output, 'design-studio/crates/design-kernel/shaders'), { recursive: true })
  const required = [
    ...REQUIRED_SNAPSHOT_IMPORTS.map(item => snapshotImportPath(output, item.from, item.specifier)),
    join(output, 'frontend/design-mcp/src/framing.mjs'),
    join(clientRoot, 'public/kernel/design_kernel_bg.wasm'),
    join(clientRoot, 'src/generated/design-kernel/design_kernel_bg.wasm'),
    join(output, 'design-studio/crates/design-kernel/shaders/sampling.wgsl'),
    join(output, 'design-studio/crates/design-kernel/shaders/byte-sampling.wgsl'),
  ]
  const missing: string[] = []
  for (const file of required) {
    try { await stat(file) } catch { missing.push(file) }
  }
  if (missing.length) throw new Error(`Isolated snapshot is missing config, plugin, MCP, or shader dependencies:\n${missing.join('\n')}`)
  const dependencyHashes = {
    publicWasmSha256: await sha256(join(clientRoot, 'public/kernel/design_kernel_bg.wasm')),
    generatedWasmSha256: await sha256(join(clientRoot, 'src/generated/design-kernel/design_kernel_bg.wasm')),
    viteConfigSha256: await sha256(join(clientRoot, 'vite.config.ts')),
    productionPublicSha256: await sha256(join(clientRoot, 'scripts/production-public.mjs')),
    runtimeConfigurationSha256: await sha256(join(output, 'frontend/design-desktop/src/render-runtime-configuration.mjs')),
    mcpOperationBackendSha256: await sha256(join(output, 'frontend/design-mcp/src/operation-backend.mjs')),
    pluginMainSha256: await sha256(join(clientRoot, 'plugins/labeled-rectangles/code.js')),
    vectorShaderSha256: await sha256(join(output, 'design-studio/crates/design-kernel/shaders/vector.wgsl')),
    samplingShaderSha256: await sha256(join(output, 'design-studio/crates/design-kernel/shaders/sampling.wgsl')),
  }
  if (dependencyHashes.publicWasmSha256 !== dependencyHashes.generatedWasmSha256)
    throw new Error('Public and generated WASM inputs differ in the isolated snapshot')
  return { clientRoot, dependencyHashes }
}
