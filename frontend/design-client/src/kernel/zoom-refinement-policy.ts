/** Zoom and pan task choice, plus preview cancellation.
 * Rust owns the schedule. This module is the only caller-facing entry:
 * surfaces and the worker do not decide the same gesture twice.
 * Ordinary motion stays at two tiles. The settled eight-tile batch is only
 * the overview or exact low-scale pipeline already on main.
 * Cancellation never releases a texture a presented frame still samples.
 * The compile probe calls `choosePreparedTile` directly so it does not nest
 * another wasm boundary inside the native cancellation checkpoint. That
 * predicate is checked against the Rust admit operation for every fence. */

import { zoom_refine_policy_json } from '../generated/design-kernel/design_kernel'
import { kernelModuleReady } from './module'

export type RefinementChoice =
  | { action: 'continue'; releaseInUse: false }
  | { action: 'cancel'; reason: 'aborted' | 'generation' | 'fill'; releaseInUse: false }
  | { action: 'cover-gap'; releaseInUse: false }

const noRelease = { releaseInUse: false as const }

export function choosePreparedTile(input: {
  aborted: boolean
  generationCurrent: boolean
  fillCurrent: boolean
  /** Canvas fill changes cancel preview work. Interaction ignores this fence. */
  enforceFill: boolean
  channelIsCanvas: boolean
  /** Only the tile whose compilation already finished may fill a gap. */
  allowGapFill: boolean
  canFillGap: boolean
}): RefinementChoice {
  if (input.aborted) return { action: 'cancel', reason: 'aborted', ...noRelease }
  if (!input.generationCurrent) return { action: 'cancel', reason: 'generation', ...noRelease }
  if (input.enforceFill && input.channelIsCanvas && !input.fillCurrent) {
    if (input.allowGapFill && input.canFillGap) return { action: 'cover-gap', ...noRelease }
    return { action: 'cancel', reason: 'fill', ...noRelease }
  }
  return { action: 'continue', ...noRelease }
}

export type RefineSchedule = {
  gate: 'schedule' | 'paint' | 'stop' | 'defer'
  cohort: 'none' | 'strip' | 'exact' | 'overview' | 'prefetch'
  priority: number
  batchLimit: number
  trace: string
  traceCode: number
  cohortCode: number
  reorderHoles: boolean
  wantStrip: boolean
  quietStrip: boolean
  suppressPrepare: boolean
  releaseCachedTiles: false
  releaseInUseResources: false
}

export type RefineScheduleInput = {
  moving: boolean
  continuousZoom: boolean
  zoomingIn: boolean
  panned: boolean
  translated: boolean
  translationFollow: boolean
  firstNative: boolean
  hasStrip: boolean
  stripCached: boolean
  pasteboard: boolean
  cpuOnly: boolean
  residentsCover: boolean
  hasBacking: boolean
  exactMissing: number
  overviewCandidates: number
  prefetchMissing: number
  outwardCover: boolean
  materialKeys: boolean
  prefetchNotReady: boolean
  optionalDelayMs: number
  overviewMode: boolean
  pipelineFullSource: boolean
  exactLattice: boolean
  rasterScale: number
}

function policy(input: object): Record<string, unknown> {
  if (!kernelModuleReady()) throw Error('缩放精修调度内核尚未就绪')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(zoom_refine_policy_json(JSON.stringify(input))) as Record<string, unknown>
  } catch (error) {
    if (String(error).includes('尚未就绪')) throw error
    throw Error('缩放精修调度无效')
  }
  const releases = parsed.releaseCachedTiles === true || parsed.releaseInUseResources === true || parsed.releaseInUse === true
  const namesRelease = parsed.releaseCachedTiles === false || parsed.releaseInUseResources === false || parsed.releaseInUse === false
  if (!parsed || releases || !namesRelease) throw Error('缩放精修取消不得释放仍在使用的资源')
  return parsed
}

function assertSchedule(value: Record<string, unknown>): RefineSchedule {
  const gate = value.gate
  const cohort = value.cohort
  const batchLimit = value.batchLimit
  const priority = value.priority
  if (gate !== 'schedule' && gate !== 'paint' && gate !== 'stop' && gate !== 'defer') throw Error('缩放精修调度无效')
  if (cohort !== 'none' && cohort !== 'strip' && cohort !== 'exact' && cohort !== 'overview' && cohort !== 'prefetch') throw Error('缩放精修调度无效')
  if (typeof batchLimit !== 'number' || typeof priority !== 'number' || typeof value.trace !== 'string' || !value.trace) throw Error('缩放精修调度无效')
  if (gate === 'schedule' ? ![1, 2, 8].includes(batchLimit) : batchLimit !== 0) throw Error('缩放精修调度无效')
  if (![0, 1, 2, 3].includes(priority)) throw Error('缩放精修调度无效')
  if (value.releaseCachedTiles !== false || value.releaseInUseResources !== false) throw Error('缩放精修取消不得释放仍在使用的资源')
  return {
    gate, cohort, priority, batchLimit, trace: value.trace,
    traceCode: Number(value.traceCode), cohortCode: Number(value.cohortCode),
    reorderHoles: value.reorderHoles === true, wantStrip: value.wantStrip === true, quietStrip: value.quietStrip === true,
    suppressPrepare: value.suppressPrepare === true, releaseCachedTiles: false, releaseInUseResources: false,
  }
}

/** The single task-selection entry. Batch size, cohort and trace come from Rust. */
export function selectZoomRefine(input: RefineScheduleInput): RefineSchedule {
  return assertSchedule(policy({ op: 'schedule', ...input }))
}

const neutralSchedule: RefineScheduleInput = {
  moving: false, continuousZoom: false, zoomingIn: false, panned: false, translated: false,
  translationFollow: false, firstNative: false, hasStrip: false, stripCached: false, pasteboard: false,
  cpuOnly: false, residentsCover: true, hasBacking: true, exactMissing: 0, overviewCandidates: 0,
  prefetchMissing: 0, outwardCover: false, materialKeys: false, prefetchNotReady: false,
  optionalDelayMs: 0, overviewMode: false, pipelineFullSource: false, exactLattice: true, rasterScale: 1,
}

/** Exact viewport tiles own the raster batch. A page overview is a candidate
 * only after that list is empty. This does not change tile pixels or budgets. */
export function exactTilesBeforeOverview<T>(exactMissing: readonly T[], overview: readonly T[]): T[] {
  const decision = selectZoomRefine({ ...neutralSchedule, exactMissing: exactMissing.length, overviewCandidates: overview.length })
  if (decision.cohort === 'exact') return [...exactMissing]
  if (decision.cohort === 'overview') return [...overview]
  if (decision.cohort === 'none') return []
  throw Error('缩放精修调度无效')
}

/** The quiet pasteboard strip may use the raster batch only when the gesture
 * has stopped and this camera's exact tiles are already cached. Invalid
 * counts refuse it. Cached tiles are not dropped by this decision. */
export function quietPasteStripAllowed(input: {
  moving: boolean
  continuousZoom: boolean
  exactMissing: number
}) {
  const parsed = policy({ op: 'quiet', moving: input.moving, continuousZoom: input.continuousZoom, exactMissing: input.exactMissing })
  return parsed.quietStrip === true
}

/** Coarse page-strip admission. Continuous zoom-out does not take the only
 * raster owner. A pan that has left resident pictures still can. */
export function coarsePanCoverNeeded(options: {
  firstNative: boolean
  hasStrip: boolean
  stripCached: boolean
  pasteboard: boolean
  cpuOnly: boolean
  translated: boolean
  moving: boolean
  continuousZoom: boolean
  translationFollow: boolean
  residentsCover: boolean
  quietStripAllowed?: boolean
}) {
  const parsed = policy({ op: 'coarse', ...options, quietStripAllowed: options.quietStripAllowed !== false })
  return parsed.wantStrip === true
}
