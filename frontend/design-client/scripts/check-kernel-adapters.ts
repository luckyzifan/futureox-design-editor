/**
 * Kernel-adapter end-to-end check: the four decoded algorithm modules
 * (inferred autolayout, layout-grid packing, gradient blur, animation
 * plan tree) exercised through the generated wasm bindings - proving the
 * kernel surface is reachable from the product side, not just in Rust.
 */
import initKernel, {
  inferred_layout_json,
  layout_grid_tracks_json,
  gradient_blur_sample,
  animation_plan_json,
} from '../src/generated/design-kernel/design_kernel'
import { blank, node } from '../src/model'

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

check('inferred autolayout derives a vertical stack', () => {
  const document = blank('adapter')
  const frame = node('frame', 0, 0, 132, 198)
  const children = [node('rectangle', 16, 16, 100, 50), node('rectangle', 16, 74, 100, 50), node('rectangle', 16, 132, 100, 50)]
  document.nodes[frame.id] = frame
  for (const child of children) {
    document.nodes[child.id] = child
    frame.children.push(child.id)
  }
  document.pages[0]!.children = [frame.id]
  const inferred = JSON.parse(inferred_layout_json(JSON.stringify(document), frame.id))
  assert(inferred.direction === 'vertical', `direction ${inferred.direction}`)
  assert(Math.abs(inferred.gap - 8) < 1e-9, `gap ${inferred.gap}`)
  assert(inferred.padding.every((p: number) => Math.abs(p - 16) < 1e-9), `padding ${inferred.padding}`)
})

check('layout-grid packing yields alternating spans', () => {
  const { 0: axis, 1: spans } = JSON.parse(layout_grid_tracks_json('[80, 80, 80]'))
  assert(spans.length === 2, `spans ${JSON.stringify(spans)}`)
  assert(spans[0].start === 0 && spans[0].end === 80, `first ${JSON.stringify(spans[0])}`)
  assert(spans[1].start === 160 && spans[1].end === 240, `second ${JSON.stringify(spans[1])}`)
  assert(axis.stride === 160 && axis.roundedSectionSize === 80, `axis ${JSON.stringify(axis)}`)
})

check('gradient blur ramps and composites through wasm', () => {
  // gradient along x 0→100, strength 0→8; at x=50 strength is 4.
  const at = (x: number) => Array.from(gradient_blur_sample(x, 0, 0, 0, 100, 0, 0, 8, true, [1, 0, 0, 1], [0, 1, 0, 1]))
  const mid = at(50)
  assert(Math.abs(mid[0] - 0.5) < 1e-9, `t ${mid[0]}`)
  assert(Math.abs(mid[1] - 4) < 1e-9, `strength ${mid[1]}`)
  const low = at(5)
  assert(low[1] < 1, `strength below 1 at start: ${low[1]}`)
  assert(low[4] === 0 && low[5] === 1 && low[6] === 0 && low[7] === 1, `sharp rgba: ${low.slice(4)}`)
})

check('animation plan pairs scenes with magic move and dissolves', () => {
  const old = blank('old scene')
  const frameA = node('frame', 0, 0, 200, 200)
  const shared = node('rectangle', 10, 10, 100, 50)
  const outgoing = node('rectangle', 10, 80, 100, 50)
  old.nodes[frameA.id] = frameA
  old.nodes[shared.id] = shared
  old.nodes[outgoing.id] = outgoing
  frameA.children = [shared.id, outgoing.id]
  old.pages[0]!.children = [frameA.id]
  const nu = blank('new scene')
  const frameB = node('frame', 320, 200, 200, 200)
  const shared2 = { ...node('rectangle', 140, 90, 100, 50), id: shared.id }
  const incoming = node('rectangle', 140, 200, 100, 50)
  nu.nodes[frameB.id] = frameB
  nu.nodes[shared2.id] = shared2
  nu.nodes[incoming.id] = incoming
  frameB.children = [shared2.id, incoming.id]
  nu.pages[0]!.children = [frameB.id]
  const plan = JSON.parse(animation_plan_json(JSON.stringify(old), JSON.stringify(nu), frameA.id, frameB.id))
  assert(plan.framePairDragTranslationDelta[0] === 320, `delta ${plan.framePairDragTranslationDelta}`)
  assert(plan.magicMove.length === 1 && plan.magicMove[0][0] === shared.id, `magic ${JSON.stringify(plan.magicMove)}`)
  assert(plan.dissolveStart[0] === outgoing.id, `start ${plan.dissolveStart}`)
  assert(plan.dissolveEnd[0] === incoming.id, `end ${plan.dissolveEnd}`)
})

if (fail.length > 0) {
  console.error(`\n${fail.length} adapter checks failed`)
  process.exit(1)
}
console.log(`\nall ${pass} kernel adapter checks passed`)
