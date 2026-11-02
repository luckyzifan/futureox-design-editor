// Production Canvas handlers + real Editor/WASM, with deterministic React-hook
// and host boundaries. No browser, renderer, GPU, or pixel-quality claim.
import React from 'react'
import { appendFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { KernelSurface } from './kernel/Surface'
import { initializePicking } from './kernel/picking'
import { blank, node } from './model'
import { allParents, worldMatrix, multiply, inverse, boxPoints, apply, scene, translate } from './geometry'
import { resizeInBasis } from './canvas-view'
import { resizedNode } from './selection-properties'
import * as smartGuides from './canvas-smart-guides'

const scans = vi.hoisted(() => ({ explicit: 0, implicit: 0 }))
vi.mock('./geometry', async importOriginal => {
  const actual = await importOriginal<typeof import('./geometry')>()
  return { ...actual,
    allParents: (...args: Parameters<typeof actual.allParents>) => { scans.explicit++; return actual.allParents(...args) },
    worldMatrix: (...args: Parameters<typeof actual.worldMatrix>) => {
      if (!args[2]) scans.implicit++
      return actual.worldMatrix(...args)
    },
  }
})
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function harness() {
  const slots: any[] = [], effects: { fn: () => any; index: number }[] = [], layouts: { fn: () => any; index: number; cleanup?: () => void }[] = []
  let cursor = 0
  const hooks = {
    useContext() { cursor++; return null },
    useCallback(fn: (...args: any[]) => any) { const i = cursor++; return slots[i] ??= fn },
    useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useMemo(fn: () => any) { cursor++; return fn() },
    useSyncExternalStore(_: any, snapshot: () => any) { cursor++; return snapshot() },
    useLayoutEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        slots[i] = { deps }; layouts.push({ fn, index: i, cleanup: old?.cleanup })
      }
    },
    useEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        old?.cleanup?.(); slots[i] = { deps }; effects.push({ fn, index: i })
      }
    },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return {
    render(fn: () => any) {
      cursor = 0; const previous = internals.H; internals.H = hooks
      let tree: any
      try { tree = fn() } finally { internals.H = previous }
      for (const { fn, index, cleanup } of layouts.splice(0)) { cleanup?.(); slots[index].cleanup = fn() }
      return tree
    },
    effects() { for (const { fn, index } of effects.splice(0)) if (String(fn).includes('initializePicking')) slots[index].cleanup = fn() },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}
function find(tree: any, match: (value: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (match(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, match); if (found) return found }
}
function fixture(size: number) {
  const doc = blank(), frame = node('frame', 0, 0, 200000, 200000), first = node('group', 30, 40, 10000, 10000), second = node('group', 3000, 4000, 10000, 10000)
  first.transform = [0, 2, -1.5, 0, 300, 400]
  second.transform = [-1.2, .1, .3, 1.5, 6000, 4000]
  frame.children = [first.id, second.id]; doc.pages[0].children = [frame.id]
  doc.nodes = { [frame.id]: frame, [first.id]: first, [second.id]: second }
  const ids: string[] = []
  for (let i = 0; i < size; i++) {
    const item = node('rectangle', 100 + i * 10, 80 + i % 4 * 20, 6, 8)
    doc.nodes[item.id] = item; (i % 2 ? first : second).children.push(item.id); ids.push(item.id)
  }
  const locked = node('rectangle', 500, 500, 10, 10); locked.locked = true
  doc.nodes[locked.id] = locked; frame.children.push(locked.id)
  const editor = new Editor(doc); editor.select(ids); editor.set({ snap: false, snapPixels: false, view: { x: 0, y: 0, zoom: 1 } })
  cleanups.push(() => editor.dispose())
  return { editor, ids, locked }
}
async function canvas(editor: Editor) {
  const h = harness(), frames = new Map<number, () => void>(); let frameId = 0
  cleanups.push(h.unmount)
  vi.stubGlobal('navigator', { platform: 'Linux' })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const host = { contains: () => true, closest: () => null, focus() {}, setPointerCapture() {}, hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }), dataset: {}, querySelectorAll: () => [] }
  let tree = h.render(() => Canvas({ editor }))
  h.effects(); await initializePicking(); for (let i = 0; i < 6; i++) await Promise.resolve()
  const surface = find(tree, value => value.type === KernelSurface)
  expect(surface).toBeDefined()
  surface.props.onPresentation({ ...surface.props, epoch: editor.sessionGeneration, pixelRatio: 1, managed: false })
  tree = h.render(() => Canvas({ editor })); tree.props.ref.current = host
  const event = (x: number, y: number, altKey = false) => ({ target: host, clientX: x, clientY: y, pointerId: 7, button: 0,
    isPrimary: true, ctrlKey: false, metaKey: false, shiftKey: false, altKey, preventDefault() {}, stopPropagation() {}, nativeEvent: {} })
  return { tree, event, flush: () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn() } },
    render: () => { tree = h.render(() => Canvas({ editor })); tree.props.ref.current = host; return tree } }
}
function report(name: string, data: Record<string, unknown>) {
  const row = { name, runtime: 'production Canvas handlers + Editor/WASM, hook/host boundary doubles', ...data }
  console.info('CANVAS_SELECTION_CPU_METRIC', JSON.stringify(row))
  if (process.env.CANVAS_SELECTION_CPU_METRICS) appendFileSync(process.env.CANVAS_SELECTION_CPU_METRICS, JSON.stringify(row) + '\n')
}

test.each([300, 3000])('resize %i nested selected nodes shares topology and consumes the release sample', async size => {
  const { editor, ids, locked } = fixture(size), c = await canvas(editor)
  const before = editor.state.doc, box = editor.selectionBounds(), start = boxPoints(box)[2]
  const handle = find(c.tree, value => value.props?.['data-testid'] === 'resize-2')
  expect(handle).toBeDefined()
  handle.props.onPointerDown(c.event(start.x, start.y))
  expect(editor.interactionActive).toBe(true)
  scans.explicit = scans.implicit = 0
  const end = { x: start.x + 20, y: start.y + 30 }, started = performance.now()
  // A pending move is intentionally newer than the last applied sample. Release
  // must cancel that queue and consume its own actual coordinates immediately.
  c.tree.props.onPointerMove(c.event(start.x + 10, start.y + 10))
  c.tree.props.onPointerUp(c.event(end.x, end.y))
  const durationMs = performance.now() - started, explicitScans = scans.explicit, implicitScans = scans.implicit
  report('resize-release', { nodes: Object.keys(before.nodes).length, selected: size, durationMs, explicitScans, implicitScans })
  expect(editor.interactionActive).toBe(false)
  const transform = resizeInBasis([1, 0, 0, 1, box.x, box.y], { x: 0, y: 0, width: box.width, height: box.height }, start, end, 2, false, false, false)
  const parents = allParents(before)
  for (const id of ids) {
    const expected = resizedNode(before.nodes[id], multiply(inverse(worldMatrix(before, parents.get(id)!, parents)), multiply(transform, worldMatrix(before, id, parents))))
    expect(editor.state.doc.nodes[id].transform).toEqual(expected.transform)
    expect(editor.state.doc.nodes[id].width).toBe(expected.width)
    expect(editor.state.doc.nodes[id].height).toBe(expected.height)
  }
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
  const after = editor.state.doc
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.redo(); expect(editor.state.doc).toEqual(after)
  const redone = editor.state.doc
  c.flush(); expect(editor.state.doc).toBe(redone)
  expect(explicitScans + implicitScans).toBeLessThanOrEqual(12)
}, 120000)

test('locked feedback remains read-only and a nested resize cancellation restores its exact snapshot', async () => {
  const { editor, ids, locked } = fixture(4), c = await canvas(editor), before = editor.state.doc
  const handle = find(c.tree, value => value.props?.['data-testid'] === 'resize-2')
  expect(handle).toBeDefined()
  const box = editor.selectionBounds(), start = boxPoints(box)[2]
  handle.props.onPointerDown(c.event(start.x, start.y))
  c.tree.props.onPointerMove(c.event(start.x + 10, start.y + 20)); c.flush()
  expect(editor.state.doc).not.toBe(before)
  c.tree.props.onPointerCancel(c.event(start.x + 10, start.y + 20))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  editor.select([ids[0], locked.id])
  const tree = c.render()
  expect(find(tree, value => value.props?.['data-testid'] === 'resize-2')).toBeUndefined()
  expect(editor.state.doc).toBe(before)
})

test('Alt duplication refreshes parent bases, toggles back without drift, and preserves cancel/history', async () => {
  const { editor, ids } = fixture(16), c = await canvas(editor), before = editor.state.doc
  const parents = allParents(before), worlds = ids.map(id => worldMatrix(before, id, parents))
  const box = editor.selectionBounds(), start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  c.tree.props.onPointerDown(c.event(start.x, start.y))
  expect(editor.interactionActive).toBe(true); expect(editor.state.selection).toEqual(ids)
  scans.explicit = scans.implicit = 0
  const started = performance.now()
  c.tree.props.onPointerMove(c.event(start.x + 20, start.y + 10, true)); c.flush()
  const durationMs = performance.now() - started, explicitScans = scans.explicit, implicitScans = scans.implicit
  report('alt-copy-sample', { selected: ids.length, durationMs, explicitScans, implicitScans })
  const copies = [...editor.state.selection]
  expect(copies).toHaveLength(ids.length)
  expect(copies.every(id => !before.nodes[id])).toBe(true)
  const checkWorlds = (selected: string[], dx: number, dy: number) => {
    const parents = allParents(editor.state.doc)
    selected.forEach((id, i) => {
      const actual = worldMatrix(editor.state.doc, id, parents), expected = [...worlds[i]]
      expected[4] += dx; expected[5] += dy
      actual.forEach((value, j) => expect(value).toBeCloseTo(expected[j], 9))
    })
  }
  checkWorlds(copies, 20, 10)
  ids.forEach(id => expect(editor.state.doc.nodes[id]).toEqual(before.nodes[id]))
  scans.explicit = scans.implicit = 0
  c.tree.props.onPointerMove(c.event(start.x + 30, start.y + 15)); c.flush()
  const offScans = { explicitScans: scans.explicit, implicitScans: scans.implicit }
  report('alt-copy-off-sample', { selected: ids.length, ...offScans })
  expect(editor.state.selection).toEqual(ids)
  expect(copies.every(id => !editor.state.doc.nodes[id])).toBe(true)
  checkWorlds(ids, 30, 15)
  scans.explicit = scans.implicit = 0
  c.tree.props.onPointerMove(c.event(start.x + 35, start.y + 18, true)); c.flush()
  const reusedScans = { explicitScans: scans.explicit, implicitScans: scans.implicit }
  report('alt-copy-reuse-sample', { selected: ids.length, ...reusedScans })
  expect(editor.state.selection).toEqual(copies); checkWorlds(copies, 35, 18)
  c.tree.props.onPointerCancel(c.event(start.x + 35, start.y + 18, true))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)

  c.tree.props.onPointerDown(c.event(start.x, start.y))
  c.tree.props.onPointerMove(c.event(start.x + 20, start.y + 10, true)); c.flush()
  c.tree.props.onPointerUp(c.event(start.x + 40, start.y + 20, true))
  expect(editor.interactionActive).toBe(false)
  checkWorlds(editor.state.selection, 40, 20)
  const committed = editor.state.doc
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.redo(); expect(editor.state.doc).toEqual(committed)
  // copyGraph and duplicateGraph still each calculate one uncached source
  // world matrix per root. The Canvas refresh adds no implicit scan of its own.
  expect(implicitScans).toBe(2 * ids.length)
  expect(explicitScans).toBeLessThanOrEqual(6)
  expect(offScans.implicitScans).toBe(0); expect(offScans.explicitScans).toBeLessThanOrEqual(6)
  expect(reusedScans.implicitScans).toBe(0); expect(reusedScans.explicitScans).toBeLessThanOrEqual(6)
})

test('smart-snap candidates preserve scene order and exclude selected subtrees without linear selection probes', async () => {
  const { editor, ids } = fixture(300)
  const parents = allParents(editor.state.doc), selectedGroup = parents.get(ids[0])!
  const moving = [selectedGroup, ...ids.filter(id => parents.get(id) !== selectedGroup)]
  editor.select(moving)
  editor.change('Page guides', doc => { doc.pages[0].guides = [
    { id: 'cpu-x-guide', axis: 'x', position: 120 }, { id: 'cpu-y-guide', axis: 'y', position: 250 },
  ] })
  editor.set({ snap: true, rulers: true })
  const c = await canvas(editor), before = editor.state.doc, entries = scene(before, editor.state.page)
  const box = editor.selectionBounds(), start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  let selectionProbes = 0
  const topSelection = editor.topSelection.bind(editor)
  vi.spyOn(editor, 'topSelection').mockImplementation(allowLocked => {
    const selected = topSelection(allowLocked)
    Object.defineProperty(selected, 'includes', { value: (value: string, from?: number) => {
      selectionProbes++
      return Array.prototype.includes.call(selected, value, from)
    } })
    return selected
  })
  c.tree.props.onPointerDown(c.event(start.x, start.y))
  expect(editor.interactionActive).toBe(true); expect(editor.state.selection).toEqual(moving)
  selectionProbes = 0
  const snap = vi.spyOn(smartGuides, 'smartGuidesSnapWorld'), started = performance.now()
  c.tree.props.onPointerMove(c.event(start.x + 20, start.y + 10)); c.flush()
  const durationMs = performance.now() - started, probes = selectionProbes
  report('smart-snap-sample', { selected: moving.length, nodes: Object.keys(before.nodes).length, durationMs, selectionProbes: probes })
  expect(snap).toHaveBeenCalledOnce()
  // Independent old array-membership reference also verifies paint-order/tie
  // ordering, which must not be changed when replacing membership with a Set.
  const expected = entries.filter(entry => !moving.includes(entry.id) && !entry.ancestors.some(id => moving.includes(id))).map(entry => entry.bounds)
  expected.push({ x: 120, y: 0, width: 0, height: 1 }, { x: 0, y: 250, width: 1, height: 0 })
  expect(snap.mock.calls[0][2]).toEqual(expected)
  expect(editor.state.doc).not.toBe(before)
  c.tree.props.onPointerCancel(c.event(start.x + 20, start.y + 10))
  expect(editor.state.doc).toBe(before)
  expect(probes).toBe(0)
})

test('multi-move final reparenting reuses its parent scan and preserves world geometry, undo, redo, and cancellation', () => {
  const { editor, ids, locked } = fixture(32)
  const destination = node('frame', 300000, 1000, 1000, 1000)
  destination.transform = [1, .2, -.1, 1, 300000, 1000]
  editor.change('Destination', doc => { doc.nodes[destination.id] = destination; doc.pages[0].children.push(destination.id) })
  const before = editor.state.doc, parents = allParents(before)
  const patches = Object.fromEntries(ids.map(id => {
    const parent = worldMatrix(before, parents.get(id)!, parents)
    return [id, { transform: multiply(inverse(parent), multiply(translate(300000, 1000), worldMatrix(before, id, parents))) }]
  }))
  const point = apply(destination.transform, { x: 200, y: 200 })
  const move = () => {
    editor.begin('Move selected into frame'); expect(editor.preview(patches)).toBe(true)
    const source = editor.state.doc, sourceParents = allParents(source), worlds = ids.map(id => worldMatrix(source, id, sourceParents))
    scans.explicit = scans.implicit = 0
    const started = performance.now()
    editor.finishCanvasMove(point, true)
    const explicitScans = scans.explicit, implicitScans = scans.implicit, durationMs = performance.now() - started
    const parents = allParents(editor.state.doc)
    ids.forEach((id, i) => {
      expect(parents.get(id)).toBe(destination.id)
      worldMatrix(editor.state.doc, id, parents).forEach((value, axis) => expect(value).toBeCloseTo(worlds[i][axis], 8))
    })
    expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
    return { explicitScans, implicitScans, durationMs }
  }
  const work = move(); editor.commit()
  report('finish-multi-move', { selected: ids.length, ...work })
  const after = editor.state.doc
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.redo(); expect(editor.state.doc).toEqual(after)
  editor.undo(); const original = editor.state.doc
  move(); editor.cancel(); expect(editor.state.doc).toBe(original)
  // previewLayoutOrder still scans once per root. Only the duplicate scan in
  // the final relocation filter is removed; reparentMany has separate work.
  expect(work.explicitScans).toBeLessThanOrEqual(ids.length + 6)
})

test('entered-frame pointerdown hits the front sibling and the drag moves only that sibling', async () => {
  const doc = blank(), frame = node('frame', 0, 0, 400, 300),
    child = node('rectangle', 40, 40, 40, 30), backing = node('rectangle', 20, 20, 300, 200)
  frame.children = [child.id, backing.id]; doc.pages[0].children = [frame.id]
  doc.nodes = Object.fromEntries([frame, child, backing].map(n => [n.id, n]))
  const editor = new Editor(doc); cleanups.push(() => editor.dispose())
  editor.select([child.id]); editor.set({ snap: false, snapPixels: false, view: { x: 0, y: 0, zoom: 1 } })
  const c = await canvas(editor), before = editor.state.doc
  c.tree.props.onPointerDown(c.event(50, 50))
  expect(editor.state.selection).toEqual([backing.id])
  c.tree.props.onPointerMove(c.event(55, 55))
  c.tree.props.onPointerUp(c.event(70, 80))
  expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
  expect(editor.state.doc.nodes[backing.id].transform).toEqual([1, 0, 0, 1, 40, 50])
  expect(editor.state.doc.nodes[frame.id]).toEqual(before.nodes[frame.id])
  expect(editor.interactionActive).toBe(false)
  const after = editor.state.doc
  c.flush(); expect(editor.state.doc).toBe(after)
  editor.undo(); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  editor.redo(); expect(editor.state.doc).toEqual(after)
})
