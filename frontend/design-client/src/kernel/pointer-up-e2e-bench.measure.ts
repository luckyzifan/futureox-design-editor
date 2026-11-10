/** Pointer-up measurement for issue #63. Not part of the default vitest include.
 * Frozen before the run: median of final preview + commit (the pointer-up turn)
 * on one already prepared synthetic document. A gain requires at least 5% and
 * non-overlapping samples versus the same command on current main. Draws are
 * not measured here. This file does not claim a private FIG or a GUI. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { test } from 'vitest'
import { Editor } from '../engine'
import { blank, effect, node, type DesignDocument, type Matrix } from '../model'
import { prepareDocument } from '../prepared-document'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { kernelLayout } from './picking'

const CHILD_COUNT = Number(process.env.FIG63_CHILD_COUNT || 20076)
const WARMUP = Number(process.env.FIG63_WARMUP || 2)
const SAMPLES = Number(process.env.FIG63_SAMPLES || 7)
const rotation: Matrix = [0, 1, -1, 0, 30, 24]
const parentRotation: Matrix = [0, 1, -1, 0, 12, 8]

function gc() {
  const collect = (globalThis as { gc?: () => void }).gc
  if (collect) collect()
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
function summary(values: number[]) {
  return { samples: values, min: Math.min(...values), median: median(values), max: Math.max(...values) }
}

function synthetic(count: number) {
  const doc = blank('synthetic pointer-up')
  doc.schemaVersion = 21
  const board = node('frame', 0, 0, 4000, 3000)
  const shadow = node('rectangle', 20, 30, 80, 40)
  shadow.effects = [effect('shadow')]
  const pinned = node('rectangle', 48, 90, 50, 30)
  pinned.constraints = {
    horizontal: 'scale', vertical: 'center',
    referenceWidth: board.width, referenceHeight: board.height,
  }
  const children = [shadow.id, pinned.id]
  const nodes: DesignDocument['nodes'] = {
    [board.id]: board, [shadow.id]: shadow, [pinned.id]: pinned,
  }
  for (let i = 0; i < count; i++) {
    const leaf = node('rectangle', (i % 200) * 8, Math.floor(i / 200) * 8, 6, 6)
    children.push(leaf.id)
    nodes[leaf.id] = leaf
  }
  board.children = children
  const wire = node('vector', 0, 3200, 40, 10)
  wire.connector = { from: { point: { x: 0, y: 0 } }, to: { point: { x: 40, y: 0 } }, style: 'straight' }
  nodes[wire.id] = wire
  doc.nodes = nodes
  doc.pages[0].children = [board.id, wire.id]
  return { doc, board, shadow, pinned, wire }
}

function descendant() {
  const doc = blank('descendant wire')
  doc.schemaVersion = 21
  const board = node('frame', 0, 0, 200, 160)
  const child = node('rectangle', 24, 18, 40, 30)
  board.children = [child.id]
  const wire = node('vector', 0, 220, 80, 10)
  wire.connector = {
    from: { point: { x: 0, y: 0 }, nodeId: child.id, anchor: { x: 0.5, y: 0.5 } },
    to: { point: { x: 120, y: 40 } }, style: 'straight',
  }
  doc.nodes = { [board.id]: board, [child.id]: child, [wire.id]: wire }
  doc.pages[0].children = [board.id, wire.id]
  return { doc, board, wire }
}

function open(doc: DesignDocument) {
  const started = performance.now()
  const editor = new Editor()
  const loaded = editor.load(prepareDocument(doc))
  editor.warmEditingHistory(editor.state.doc, editor.sessionGeneration)
  return { editor, loaded, prepareMs: performance.now() - started }
}

/** Pointer-up is the release preview plus commit, after earlier in-gesture previews. */
function pointerUp(editor: Editor, id: string, transform: Matrix) {
  const before = editor.state.doc.nodes[id].transform
  editor.begin('旋转')
  const during = transform.map((value, index) => index < 4 ? value : value - 4) as Matrix
  editor.preview({ [id]: { transform: during } })
  gc()
  const t0 = performance.now()
  const previewOk = editor.preview({ [id]: { transform } })
  const t1 = performance.now()
  const commit = editor.commit()
  const t2 = performance.now()
  editor.undo()
  const t3 = performance.now()
  const restored = editor.state.doc.nodes[id].transform.every((value, index) => Object.is(value, before[index]))
  return {
    previewOk, commitStatus: commit?.status ?? 'none', restored,
    previewMs: t1 - t0, commitMs: t2 - t1, pointerUpMs: t2 - t0, undoMs: t3 - t2,
  }
}

function runCase(editor: Editor, id: string, transform: Matrix) {
  for (let i = 0; i < WARMUP; i++) pointerUp(editor, id, transform)
  const rows = []
  for (let i = 0; i < SAMPLES; i++) rows.push(pointerUp(editor, id, transform))
  return {
    rows,
    preview: summary(rows.map(row => row.previewMs)),
    commit: summary(rows.map(row => row.commitMs)),
    pointerUp: summary(rows.map(row => row.pointerUpMs)),
    undo: summary(rows.map(row => row.undoMs)),
    allCommitted: rows.every(row => row.previewOk && row.commitStatus === 'committed' && row.restored),
  }
}

test('measure prepared pointer-up against the synthetic large document', () => {
  const built = synthetic(CHILD_COUNT)
  const opened = open(built.doc)
  if (!opened.loaded) throw new Error('editor did not load the synthetic document')
  const editor = opened.editor
  const nodeCount = Object.keys(editor.state.doc.nodes).length
  gc()
  const memoryBefore = process.memoryUsage()
  let effectCase, parentCase
  try {
    effectCase = runCase(editor, built.shadow.id, rotation)
    parentCase = runCase(editor, built.board.id, parentRotation)
    const before = editor.state.doc
    editor.begin('旋转')
    editor.preview({ [built.shadow.id]: { transform: rotation } })
    const effectDoc = editor.state.doc
    editor.commit()
    const effectCandidate = {
      ...before,
      nodes: { ...before.nodes, [built.shadow.id]: { ...before.nodes[built.shadow.id], transform: rotation } },
    }
    const effectOracle = kernelLayout(effectCandidate)
    editor.undo()
    editor.begin('旋转画板')
    editor.preview({ [built.board.id]: { transform: parentRotation } })
    const parentDoc = editor.state.doc
    const parentCandidate = {
      ...before,
      nodes: { ...before.nodes, [built.board.id]: { ...before.nodes[built.board.id], transform: parentRotation } },
    }
    const parentOracle = kernelLayout(parentCandidate)
    const geometry = (published: DesignDocument, oracle: DesignDocument, ids: string[]) =>
      ids.every(id => published.nodes[id].transform.every((value, index) => Object.is(value, oracle.nodes[id].transform[index]))
        && published.nodes[id].width === oracle.nodes[id].width
        && published.nodes[id].height === oracle.nodes[id].height)
    const descendantDoc = descendant()
    const descendantEditor = open(descendantDoc.doc)
    const descendantBase = descendantEditor.editor.state.doc
    descendantEditor.editor.begin('旋转画板')
    descendantEditor.editor.preview({ [descendantDoc.board.id]: { transform: parentRotation } })
    const descendantPublished = descendantEditor.editor.state.doc
    const descendantInput = {
      ...descendantBase,
      nodes: {
        ...descendantBase.nodes,
        [descendantDoc.board.id]: { ...descendantBase.nodes[descendantDoc.board.id], transform: parentRotation },
      },
    }
    const descendantOracle = kernelLayout(descendantInput)
    const fullEngine = new VectorEngine()
    let fullWire: { transform?: Matrix } | undefined
    try {
      const reply = JSON.parse(fullEngine.resolve_components_full(JSON.stringify(descendantInput))) as {
        nodes: Record<string, { transform?: Matrix }>
      }
      fullWire = reply.nodes[descendantDoc.wire.id]
    } finally { fullEngine.free() }
    const wireBefore = descendantBase.nodes[descendantDoc.wire.id].transform
    const wireAfter = descendantPublished.nodes[descendantDoc.wire.id].transform
    gc()
    const memoryAfter = process.memoryUsage()
    const wasm = readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url))
    const result = {
      role: process.env.FIG63_ROLE || 'unspecified',
      commit: process.env.FIG63_COMMIT || 'unspecified',
      profile: 'release',
      node: process.version,
      platform: process.platform,
      childCount: CHILD_COUNT,
      nodeCount,
      prepareMs: opened.prepareMs,
      wasmSha256: createHash('sha256').update(wasm).digest('hex'),
      draws: 'NOT_RUN',
      gui: false,
      electron: false,
      metal: false,
      fixture: 'synthetic-generated-in-process',
      privateFig: false,
      warmup: WARMUP,
      samples: SAMPLES,
      effectRotation: effectCase,
      parentRotation: parentCase,
      geometryAgreesWithLayout: {
        effect: geometry(effectDoc, effectOracle, [built.shadow.id, built.pinned.id, built.wire.id]),
        parent: geometry(parentDoc, parentOracle, [built.board.id, built.pinned.id, built.shadow.id, built.wire.id]),
      },
      descendantWire: {
        moved: wireAfter.some((value, index) => !Object.is(value, wireBefore[index])),
        matchesLayout: wireAfter.every((value, index) => Object.is(value, descendantOracle.nodes[descendantDoc.wire.id].transform[index])),
        matchesFullResolve: !!fullWire?.transform && wireAfter.every((value, index) => Object.is(value, fullWire!.transform![index])),
      },
      memory: {
        heapUsedBefore: memoryBefore.heapUsed,
        rssBefore: memoryBefore.rss,
        heapUsedAfter: memoryAfter.heapUsed,
        rssAfter: memoryAfter.rss,
      },
    }
    const path = process.env.FIG63_RESULT
    if (path) writeFileSync(path, JSON.stringify(result))
    console.log(JSON.stringify(result))
    if (!effectCase.allCommitted || !parentCase.allCommitted) throw new Error('a measured gesture did not commit and undo')
    if (!result.geometryAgreesWithLayout.effect || !result.geometryAgreesWithLayout.parent)
      throw new Error('published geometry does not match kernelLayout')
    if (process.env.FIG63_REQUIRE_DESCENDANT === '1' &&
      (!result.descendantWire.moved || !result.descendantWire.matchesLayout || !result.descendantWire.matchesFullResolve))
      throw new Error('descendant wire was not published at the full-resolve position')
    descendantEditor.editor.dispose()
  } finally { editor.dispose() }
})
