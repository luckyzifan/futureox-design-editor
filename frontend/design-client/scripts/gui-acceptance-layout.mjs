/** Path and save-label contract for the GUI acceptance entry. The visible
 * autosave sentence is not itself a durable write. */
import { spawn } from 'node:child_process'
import path from 'node:path'

export const CURRENT_WORKSPACE_SAVE_LABEL = '已自动保存到工作副本'

/** Exact current workspace sentence. The retired "已保存到本机" copy does not match. */
export function isCurrentWorkspaceSaveLabel(value) {
  return value === CURRENT_WORKSPACE_SAVE_LABEL
}

/** Where a Vite relative import lands inside an isolated snapshot root. */
export function snapshotImportPath(output, from, specifier) {
  return path.resolve(output, path.dirname(from), specifier)
}

/** Imports the dev server and the editor actually load. An `output/client`
 * copy does not satisfy the second hop through design-desktop/scripts. */
export const REQUIRED_SNAPSHOT_IMPORTS = Object.freeze([
  { from: 'frontend/design-client/vite.config.ts', specifier: '../design-desktop/scripts/render-diagnostic-build.mjs' },
  { from: 'frontend/design-client/vite.config.ts', specifier: './scripts/production-public.mjs' },
  { from: 'frontend/design-desktop/scripts/render-diagnostic-build.mjs', specifier: '../../design-client/scripts/production-public.mjs' },
  { from: 'frontend/design-client/src/kernel/gpu/webgpu.ts', specifier: '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl' },
  { from: 'frontend/design-client/src/design-ai/apply-operations.ts', specifier: '../../../design-mcp/src/operation-backend.mjs' },
  { from: 'frontend/design-client/src/plugins/sample-plugin.ts', specifier: '../../plugins/labeled-rectangles/code.js' },
  { from: 'frontend/design-client/src/kernel/render-failure-telemetry.ts', specifier: '../../../design-desktop/src/render-runtime-configuration.mjs' },
])

export function spawnOwned(command, args, options = {}) {
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...options })
}

/** Stops one owned process group. A sibling group is left running. */
export async function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const pid = child.pid
  if (!pid) return
  try { process.kill(-pid, 'SIGTERM') }
  catch { try { child.kill('SIGTERM') } catch { /* already exited */ } }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already exited */ } }
      }
      resolve()
    }, 1500)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

/** Counts recorded checks. An unrecorded throw is one failed execution, not a pass. */
export function acceptanceCounts(command, checks, error, entered) {
  const list = Array.isArray(checks) ? checks : []
  const skipped = list.filter(check => check?.status === 'skipped').length
  const recordedFailed = list.filter(check => check?.status === 'failed').length
  const passed = list.length - recordedFailed - skipped
  const failed = recordedFailed + (error ? 1 : 0)
  return {
    command,
    entered: !!entered,
    executed: list.length + (error ? 1 : 0),
    passed,
    failed,
    skipped,
    ...(error ? { error: String(error).split('\n')[0] } : {}),
  }
}
