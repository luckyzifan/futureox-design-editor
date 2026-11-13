/** Zoom and pan task choice, plus preview cancellation.
 * Rust owns both decisions. This module only packs facts and unpacks the
 * integer the kernel returns. It does not judge the gesture again.
 * A final word never releases a texture a presented frame still samples.
 * Page-overview geometry is requested only when the kernel asks for it, so an
 * exact-viewport hole does not plan that source range.
 */

import { zoom_refine_admit, zoom_refine_select } from '../generated/design-kernel/design_kernel'
import { kernelModuleReady } from './module'

const MOVING = 1 << 0
const CONTINUOUS = 1 << 1
const ZOOMING_IN = 1 << 2
const PANNED = 1 << 3
const TRANSLATED = 1 << 4
const TRANSLATION_FOLLOW = 1 << 5
const FIRST_NATIVE = 1 << 6
const HAS_STRIP = 1 << 7
const STRIP_CACHED = 1 << 8
const PASTEBOARD = 1 << 9
const CPU_ONLY = 1 << 10
const RESIDENTS_COVER = 1 << 11
const HAS_BACKING = 1 << 12
const OUTWARD_COVER = 1 << 13
const MATERIAL = 1 << 14
const PREFETCH_NOT_READY = 1 << 15
const OVERVIEW_MODE = 1 << 16
const PIPELINE = 1 << 17
const EXACT_LATTICE = 1 << 18
const CAN_BUILD_STRIP = 1 << 19
const STRIP_MEASURED = 1 << 20
const OVERVIEW_SUPPLIED = 1 << 21
const PREFETCH_SUPPLIED = 1 << 22
const OVERVIEW_READY = 1 << 23
const COSTLY_OVERVIEW = 1 << 24
const OVERVIEW_IS_COLD = 1 << 25
const OUTWARD_KNOWN = 1 << 27

const TRACE = [
  '',
  'paint-first-native',
  'paint-outward-cover',
  'stop-material-moving',
  'paint-moving-prefetch',
  'defer-optional',
  'strip-cpu',
  'strip-translated',
  'strip-quiet',
  'strip-bootstrap',
  'strip-pan-follow',
  'exact-viewport',
  'overview',
  'prefetch',
  'stop-empty',
]
const GATES = ['schedule', 'paint', 'stop', 'defer'] as const
const COHORTS = ['none', 'strip', 'exact', 'overview', 'prefetch'] as const

export type RefineFacts = {
  moving: boolean
  continuousZoom: boolean
  zoomingIn: boolean
  panned: boolean
  translated: boolean
  translationFollow: boolean
  firstNative: boolean
  cpuOnly: boolean
  residentsCover: boolean
  hasBacking: boolean
  outwardCover: boolean
  outwardKnown: boolean
  materialKeys: boolean
  prefetchNotReady: boolean
  overviewMode: boolean
  pipelineFullSource: boolean
  exactLattice: boolean
  canBuildStrip: boolean
  hasStrip: boolean
  stripCached: boolean
  pasteboard: boolean
  stripMeasured: boolean
  overviewSupplied: boolean
  prefetchSupplied: boolean
  overviewReady: boolean
  costlyOverview: boolean
  overviewIsCold: boolean
  exactMissing: number
  overviewCandidates: number
  prefetchMissing: number
  optionalDelayMs: number
  rasterScale: number
  shownCount: number
  tileCount: number
  coldBudget: number
  sourceNodes: number
  sourceWidth: number
  sourceHeight: number
}

export type RefineSchedule = {
  gate: (typeof GATES)[number]
  cohort: (typeof COHORTS)[number]
  priority: number
  batchLimit: number
  trace: string
  traceCode: number
  cohortCode: number
  reorderHoles: boolean
  wantStrip: boolean
  quietStrip: boolean
  suppressPrepare: boolean
  consumesCold: boolean
  stripGeometry: boolean
  releaseCachedTiles: false
  releaseInUseResources: false
  delayMs: number
}

export type RefineHooks = {
  measureStrip: () => { hasStrip: boolean; stripCached: boolean; pasteboard: boolean }
  outwardCover: () => boolean
  overviewCandidates: (kind: 'cold' | 'warm') => number
  prefetchCount: () => number
}

let scheduleCalls = 0
/** Test counter for packed select calls. Production code does not branch on it. */
export function takeScheduleCalls() {
  const count = scheduleCalls
  scheduleCalls = 0
  return count
}

function bit(value: boolean, flag: number) {
  return value ? flag : 0
}

function count(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) return 0
  return value > 0xffffffff ? 0xffffffff : value
}

function pack(input: RefineFacts) {
  return bit(input.moving, MOVING)
    | bit(input.continuousZoom, CONTINUOUS)
    | bit(input.zoomingIn, ZOOMING_IN)
    | bit(input.panned, PANNED)
    | bit(input.translated, TRANSLATED)
    | bit(input.translationFollow, TRANSLATION_FOLLOW)
    | bit(input.firstNative, FIRST_NATIVE)
    | bit(input.hasStrip, HAS_STRIP)
    | bit(input.stripCached, STRIP_CACHED)
    | bit(input.pasteboard, PASTEBOARD)
    | bit(input.cpuOnly, CPU_ONLY)
    | bit(input.residentsCover, RESIDENTS_COVER)
    | bit(input.hasBacking, HAS_BACKING)
    | bit(input.outwardCover, OUTWARD_COVER)
    | bit(input.materialKeys, MATERIAL)
    | bit(input.prefetchNotReady, PREFETCH_NOT_READY)
    | bit(input.overviewMode, OVERVIEW_MODE)
    | bit(input.pipelineFullSource, PIPELINE)
    | bit(input.exactLattice, EXACT_LATTICE)
    | bit(input.canBuildStrip, CAN_BUILD_STRIP)
    | bit(input.stripMeasured, STRIP_MEASURED)
    | bit(input.overviewSupplied, OVERVIEW_SUPPLIED)
    | bit(input.prefetchSupplied, PREFETCH_SUPPLIED)
    | bit(input.overviewReady, OVERVIEW_READY)
    | bit(input.costlyOverview, COSTLY_OVERVIEW)
    | bit(input.overviewIsCold, OVERVIEW_IS_COLD)
    | bit(input.outwardKnown, OUTWARD_KNOWN)
}

function callSelect(input: RefineFacts) {
  if (!kernelModuleReady()) throw Error('缩放精修调度内核尚未就绪')
  scheduleCalls += 1
  return zoom_refine_select(
    pack(input) >>> 0,
    input.exactMissing,
    count(input.overviewCandidates) >>> 0,
    count(input.prefetchMissing) >>> 0,
    input.optionalDelayMs,
    input.rasterScale,
    count(input.shownCount) >>> 0,
    count(input.tileCount) >>> 0,
    count(input.coldBudget) >>> 0,
    count(input.sourceNodes) >>> 0,
    input.sourceWidth,
    input.sourceHeight,
  ) >>> 0
}

function unpack(word: number, delayMs: number): RefineSchedule {
  if ((word >>> 28) & 3) throw Error('缩放精修取消不得释放仍在使用的资源')
  if ((word >>> 31) & 1) throw Error('缩放精修调度无效')
  const gate = GATES[word & 3]
  const cohortCode = (word >>> 2) & 7
  const cohort = COHORTS[cohortCode]
  const priority = (word >>> 5) & 7
  const batchLimit = (word >>> 8) & 255
  const traceCode = (word >>> 16) & 127
  const trace = TRACE[traceCode]
  if (!gate || !cohort || !trace || priority > 3) throw Error('缩放精修调度无效')
  if (gate === 'schedule' ? ![1, 2, 8].includes(batchLimit) || cohort === 'none' : batchLimit !== 0 || cohort !== 'none')
    throw Error('缩放精修调度无效')
  return {
    gate, cohort, priority, batchLimit, trace, traceCode, cohortCode,
    reorderHoles: ((word >>> 24) & 1) === 1,
    wantStrip: ((word >>> 25) & 1) === 1,
    quietStrip: ((word >>> 26) & 1) === 1,
    suppressPrepare: ((word >>> 27) & 1) === 1,
    consumesCold: ((word >>> 23) & 1) === 1,
    stripGeometry: ((word >>> 30) & 1) === 1,
    releaseCachedTiles: false,
    releaseInUseResources: false,
    delayMs,
  }
}

/** The single task-selection entry used by the source surface. */
export function scheduleZoomRefine(input: RefineFacts, hooks: RefineHooks): RefineSchedule {
  const facts: RefineFacts = { ...input }
  for (let hop = 0; hop < 6; hop++) {
    const word = callSelect(facts)
    if (((word >>> 31) & 1) === 0) return unpack(word, facts.optionalDelayMs)
    if ((word >>> 28) & 3) throw Error('缩放精修取消不得释放仍在使用的资源')
    const kind = (word >>> 5) & 7
    if (kind === 1) {
      if (facts.stripMeasured) throw Error('缩放精修调度无效')
      const measured = hooks.measureStrip()
      facts.stripMeasured = true
      facts.hasStrip = measured.hasStrip
      facts.stripCached = measured.stripCached
      facts.pasteboard = measured.pasteboard
      continue
    }
    if (kind === 5) {
      if (facts.outwardKnown) throw Error('缩放精修调度无效')
      facts.outwardKnown = true
      facts.outwardCover = hooks.outwardCover()
      continue
    }
    if (kind === 2 || kind === 3) {
      if (facts.overviewSupplied) throw Error('缩放精修调度无效')
      facts.overviewIsCold = kind === 2
      facts.overviewCandidates = hooks.overviewCandidates(kind === 2 ? 'cold' : 'warm')
      facts.overviewSupplied = true
      continue
    }
    if (kind === 4) {
      if (facts.prefetchSupplied) throw Error('缩放精修调度无效')
      facts.prefetchMissing = hooks.prefetchCount()
      facts.prefetchSupplied = true
      continue
    }
    throw Error('缩放精修调度无效')
  }
  throw Error('缩放精修调度无效')
}

const ADMIT_CACHE = new Uint8Array(128)
const ADMIT_READY = new Uint8Array(128)

/** Memoised kernel admission. The 7 fact bits are the whole input, so a
 * repeated fence is an array load rather than another judgment or allocation. */
export function admitPreparedTile(flags: number) {
  if ((flags >>> 0) !== flags || flags > 127) throw Error('缩放精修调度无效')
  if (!ADMIT_READY[flags]) {
    if (!kernelModuleReady()) throw Error('缩放精修调度内核尚未就绪')
    const word = zoom_refine_admit(flags) >>> 0
    if (word & ~0b1111) throw Error('缩放精修取消不得释放仍在使用的资源')
    ADMIT_CACHE[flags] = word
    ADMIT_READY[flags] = 1
  }
  return ADMIT_CACHE[flags]!
}

export function admitAction(word: number): 'continue' | 'cancel' | 'cover-gap' {
  const action = word & 3
  if (action === 0) return 'continue'
  if (action === 1) return 'cancel'
  if (action === 2) return 'cover-gap'
  throw Error('缩放精修调度无效')
}

export function admitReason(word: number): 'aborted' | 'generation' | 'fill' | undefined {
  if ((word & 3) !== 1) return undefined
  const reason = (word >>> 2) & 3
  if (reason === 1) return 'aborted'
  if (reason === 2) return 'generation'
  if (reason === 3) return 'fill'
  throw Error('缩放精修调度无效')
}
