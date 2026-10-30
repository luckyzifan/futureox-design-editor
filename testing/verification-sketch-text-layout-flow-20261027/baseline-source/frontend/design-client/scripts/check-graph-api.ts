/**
 * Graph API end-to-end check against the built wasm kernel:
 * handles, facet composition, op-log undo/redo, binary documents,
 * compressed sync frames and tile-stack geometry.
 */
import initKernel from '../src/generated/design-kernel/design_kernel'
import { blank, node, uid } from '../src/model'
import { Graph, GraphApiHandleError, INVALID_HANDLE } from '../src/kernel/graph'

await initKernel()

let pass = 0
const fail: string[] = []
function check(name: string, body: () => void) {
  try {
    body()
    pass += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    fail.push(name)
    console.error(`FAIL ${name}: ${(error as Error).message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const document = blank('Graph API check')
const frame = node('rectangle', 100, 100, 120, 80)
frame.name = 'Hero'
document.nodes[frame.id] = frame
document.pages[0]!.children = [frame.id]
const child = node('ellipse', 10, 10, 40, 30)
document.nodes[child.id] = child
frame.children = [child.id]
const stackFrame = node('frame', 300, 100, 200, 140)
stackFrame.name = 'Autolayout'
document.nodes[stackFrame.id] = stackFrame
document.pages[0]!.children = [...document.pages[0]!.children, stackFrame.id]

using graph = Graph.open(JSON.stringify(document))
const frameHandle = graph.handle(frame.id)
const stackFrameHandle = graph.handle(stackFrame.id)
const childHandle = graph.handle(child.id)
const pageHandle = graph.handle(document.pages[0]!.id)

check('handles resolve nodes', () => {
  assert(graph.id(frameHandle) === frame.id, 'id round trip')
  assert(graph.kind(frameHandle) === 'rectangle', `kind is rectangle, got ${graph.kind(frameHandle)}`)
  assert(graph.handle(uid()) === INVALID_HANDLE, 'unknown id is invalid')
})

check('graph traversal', () => {
  assert(graph.children(frameHandle).includes(childHandle), 'children include ellipse')
  assert(graph.parent(childHandle) === frameHandle, 'parent resolves')
  assert(graph.containingPage(childHandle) === pageHandle, 'containing page resolves')
})

check('facet composition', () => {
  graph.applyFacet(stackFrameHandle, 'stack', {
    kind: 'stack',
    horizontal: true,
    grid: false,
    gap: 8,
    padding: [4, 4, 4, 4],
  })
  const stack = graph.facet<{ kind: 'stack'; gap: number }>(stackFrameHandle, 'stack')
  assert(stack !== undefined && stack.gap === 8, 'stack facet round trip')
  assert(graph.facetKinds(stackFrameHandle).includes('stack'), 'facet kinds include stack')
  const text = graph.facet<{ kind: 'text' }>(childHandle, 'text')
  assert(text === undefined, 'ellipse exposes no text facet')
})

check('all edits flow through the op log', () => {
  assert(graph.undoDepth() === 1, 'stack apply pushed one undo entry')
  graph.setName(frameHandle, 'Renamed')
  assert(graph.name(frameHandle) === 'Renamed', 'rename visible')
  assert(graph.undo(), 'undo runs')
  assert(graph.name(frameHandle) === 'Hero', 'undo restores name')
  assert(graph.redo(), 'redo runs')
  assert(graph.name(frameHandle) === 'Renamed', 'redo re-applies name')
})

check('scale transform commits extent and matrix', () => {
  graph.setTransform(frameHandle, [1, 0, 0, 1, 50, 60])
  graph.scale(frameHandle, 2)
  const matrix = graph.transform(frameHandle)
  assert(matrix[0] === 2 && matrix[4] === 100 && matrix[5] === 120, `scaled matrix ${matrix}`)
  assert(graph.undo(), 'scale undo runs')
  assert(graph.transform(frameHandle)[0] === 1, 'undo restores matrix')
})

check('ops transport frames round trip with lz4', () => {
  const ops = [{ type: 'setName', id: frame.id, name: 'Net' }] as const
  const frameBytes = graph.opsFrame([...ops], 42, true)
  const decoded = graph.decodeOpsFrame(frameBytes, true)
  assert(decoded.revision === 42, `revision preserved, got ${decoded.revision}`)
  graph.applyOps(decoded.ops)
  assert(graph.name(frameHandle) === 'Net', 'decoded ops apply')
})

check('binary document export/import', () => {
  const bytes = graph.exportBinary()
  assert(bytes.length > 0 && bytes.length < JSON.stringify(document).length,
    `binary ${bytes.length} beats json ${JSON.stringify(document).length}`)
  graph.importBinary(bytes)
  assert(graph.name(frameHandle) === 'Net', 'name survives binary round trip')
})

check('tile stack geometry', () => {
  assert(graph.levelForZoom(1) === 0, 'zoom 1 is level 0')
  assert(graph.levelForZoom(4) === 2, 'zoom 4 is level 2')
  const tile = graph.tile(0, 2, -1)
  const viewport = graph.tileViewport(tile)
  assert(viewport[0] === 512 && viewport[1] === -256, `viewport ${viewport}`)
  const clear = graph.tileScissorForClear(tile)
  assert(clear[2] === 256 && clear[3] === 256, `clear scissor ${clear}`)
  assert(graph.tileNeedsColorClear(tile), 'default tile needs color clear')
  const m = graph.tileToNode(1, 3, 2)
  assert(m[0] === 0.5, `level-1 tile matrix ${m}`)
  graph.releaseTile(tile)
})

check('stale handles are rejected', () => {
  let rejected = false
  try {
    graph.name(999999)
  } catch (error) {
    rejected = error instanceof GraphApiHandleError
  }
  assert(rejected, 'unknown handle throws GraphApiHandleError')
})

if (fail.length > 0) {
  console.error(`\n${fail.length} checks failed`)
  process.exit(1)
}
console.log(`\nall ${pass} graph api checks passed`)
