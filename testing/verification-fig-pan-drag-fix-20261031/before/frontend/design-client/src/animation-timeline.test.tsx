/// <reference types="node" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import React from 'react'
import { Editor } from './engine'
import { blank, node } from './model'
import {
  clampKeyframeTime,
  createClip,
  moveKeyframeTime,
  removeKeyframeAt,
  timelineRatio,
  timelineTickStepMs,
  timelineTimeAt,
  type Easing,
  type Keyframe,
} from './animation'
import { Timeline } from './AnimationPanel'

function find(tree: any, predicate: (value: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) {
    const match = find(child, predicate)
    if (match) return match
  }
}
// Minimal hook stubs (mirrors workspace-ui.test.tsx): the component function
// renders directly so pointer/keyboard handlers can be invoked by hand. Each
// state change requires a fresh render() because closures capture old state.
function componentHarness() {
  const slots: any[] = []
  let cursor = 0
  const hooks = {
    useState(initial: any) {
      const at = cursor++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (value: any) => { slots[at] = value }]
    },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial } },
    useEffect() { cursor++ },
    useMemo(fn: () => any) { cursor++; return fn() },
    useSyncExternalStore(_subscribe: any, snapshot: () => any) { cursor++; return snapshot() },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return {
    render(fn: () => any) {
      cursor = 0
      const old = internals.H
      internals.H = hooks
      try { return fn() } finally { internals.H = old }
    },
  }
}

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.dispose()))
function fixture() {
  const doc = blank(), rect = node('rectangle', 10, 20, 100, 80)
  doc.nodes[rect.id] = rect
  doc.pages[0].children = [rect.id]
  doc.animations = [createClip(doc, doc.pages[0].id, [rect.id])]
  const editor = new Editor(doc)
  editors.push(editor)
  return { editor, nodeId: rect.id }
}
const linear: Easing = { kind: 'linear' }
const lane = { getBoundingClientRect: () => ({ left: 40, width: 200 }) },
  keyframeTarget = {
    closest: (selector: string) => (selector === '.animation-track-lane' ? lane : null),
    setPointerCapture: () => {},
  }

describe('timeline math', () => {
  test('keyframe time maps to a lane ratio with clamping', () => {
    expect(timelineRatio(0, 1000)).toBe(0)
    expect(timelineRatio(500, 1000)).toBeCloseTo(0.5)
    expect(timelineRatio(1000, 1000)).toBe(1)
    expect(timelineRatio(2500, 1000)).toBe(1)
    expect(timelineRatio(-5, 1000)).toBe(0)
    expect(timelineRatio(400, 0)).toBe(0)
  })
  test('lane pixels convert to clamped keyframe times snapped to 10ms', () => {
    expect(timelineTimeAt(100, 200, 1000)).toBe(500)
    // 53px of a 200px lane over 1000ms = 265ms, snapped up to 270ms.
    expect(timelineTimeAt(53, 200, 1000)).toBe(270)
    expect(timelineTimeAt(9999, 200, 1000)).toBe(1000)
    expect(timelineTimeAt(-50, 200, 1000)).toBe(0)
    expect(timelineTimeAt(10, 0, 1000)).toBe(0)
  })
  test('ruler keeps per-second ticks when possible and subdivides short clips', () => {
    expect(timelineTickStepMs(3000)).toBe(1000)
    expect(timelineTickStepMs(10000)).toBe(1000)
    expect(timelineTickStepMs(20000)).toBe(2000)
    expect(timelineTickStepMs(1000)).toBe(250)
  })
  test('moves reorder stably and reject landing on an occupied time', () => {
    const a = { timeMs: 0, value: { kind: 'rectangle' }, easing: { kind: 'linear' } } as Keyframe,
      b = { timeMs: 1000, value: { kind: 'rectangle' }, easing: { kind: 'hold' } } as Keyframe,
      list = [a, b]
    // The kernel validator demands strictly increasing times, so a colliding
    // move is rejected outright and the array reference is preserved.
    expect(moveKeyframeTime(list, 0, 1000)).toBe(list)
    const moved = moveKeyframeTime(list, 0, 500)
    expect(moved.map((k) => k.timeMs)).toEqual([500, 1000])
    expect(moved.map((k) => k.easing.kind)).toEqual(['linear', 'hold'])
    expect(moveKeyframeTime(list, -1, 500)).toBe(list)
    expect(removeKeyframeAt(list, 9)).toBe(list)
    expect(removeKeyframeAt(list, 0)).toHaveLength(1)
  })
  test('drag targets clamp one snap slot away from the neighboring keyframes', () => {
    const k = (t: number) => ({ timeMs: t, value: { kind: 'rectangle' }, easing: { kind: 'linear' } }) as Keyframe
    expect(clampKeyframeTime([k(0), k(100), k(1000)], 1, 500)).toBe(500)
    expect(clampKeyframeTime([k(0), k(100), k(1000)], 1, 1000)).toBe(990)
    expect(clampKeyframeTime([k(0), k(100), k(1000)], 1, 0)).toBe(10)
    expect(clampKeyframeTime([k(0)], 0, 400)).toBe(400)
    expect(clampKeyframeTime([k(0), k(5)], 0, 300)).toBe(-5)
  })
})

describe('timeline interactions', () => {
  function timelineHarness() {
    const { editor, nodeId } = fixture(),
      harness = componentHarness(),
      onTime = vi.fn(),
      renderTL = () =>
        harness.render(() =>
          Timeline({
            clip: editor.state.doc.animations![0],
            editor,
            easing: linear,
            time: 0,
            onTime,
            playheadMs: null,
          }),
        )
    const keyAt = (tree: any, ms: number) =>
      find(tree, (v) => v.props?.['aria-label'] === `${nodeId} ${ms}ms`)
    return { editor, nodeId, renderTL, keyAt, onTime }
  }

  test('dragging a keyframe commits one editor.change and lands on the snapped time', () => {
    const { editor, nodeId, renderTL, keyAt } = timelineHarness()
    keyAt(renderTL(), 1000).props.onPointerDown({
      button: 0,
      pointerId: 1,
      clientX: 140,
      currentTarget: keyframeTarget,
    })
    keyAt(renderTL(), 1000).props.onPointerMove({ clientX: 93 })
    const dragged = keyAt(renderTL(), 270)
    expect(dragged).toBeDefined()
    dragged.props.onPointerUp({})
    const track = editor.state.doc.animations![0].tracks.find((t) => t.nodeId === nodeId)!
    expect(track.keyframes.map((k) => k.timeMs)).toEqual([0, 270])
    // One undo boundary: a single editor.change restored the previous layout.
    editor.undo()
    expect(editor.state.doc.animations![0].tracks[0].keyframes.map((k) => k.timeMs)).toEqual([
      0, 1000,
    ])
  })

  test('a drag towards an occupied slot clamps and keeps a stable order', () => {
    const { editor, renderTL, keyAt } = timelineHarness(),
      track = () => editor.state.doc.animations![0].tracks[0]
    editor.change('区分位姿', (d) => {
      d.animations![0].tracks[0].keyframes[1].value.transform[4] += 55
    })
    const [x0, x1] = track().keyframes.map((k) => k.value.transform[4])
    keyAt(renderTL(), 0).props.onPointerDown({
      button: 0,
      pointerId: 1,
      clientX: 40,
      currentTarget: keyframeTarget,
    })
    keyAt(renderTL(), 0).props.onPointerMove({ clientX: 240 })
    // 1000ms is occupied by the next keyframe: the drag clamps to 990ms.
    keyAt(renderTL(), 990).props.onPointerUp({})
    expect(track().keyframes.map((k) => k.timeMs)).toEqual([990, 1000])
    expect(track().keyframes.map((k) => k.value.transform[4])).toEqual([x0, x1])
  })

  test('deleting keyframes shrinks the track and removes the row when empty', () => {
    const { editor, nodeId, renderTL, keyAt } = timelineHarness(),
      track = () => editor.state.doc.animations![0].tracks[0]
    keyAt(renderTL(), 0).props.onKeyDown({ key: 'Delete', preventDefault() {} })
    expect(track().keyframes.map((k) => k.timeMs)).toEqual([1000])
    expect(
      find(renderTL(), (v) => v.props?.['data-testid'] === `lane-${nodeId}`),
    ).toBeDefined()
    keyAt(renderTL(), 1000).props.onKeyDown({ key: 'Backspace', preventDefault() {} })
    // Dropping the last keyframe drops the row; the engine's pruneAnimations
    // then removes the now track-less clip from the document entirely.
    expect(editor.state.doc.animations?.length ?? 0).toBe(0)
    editor.undo()
    expect(track().keyframes.map((k) => k.timeMs)).toEqual([1000])
  })

  test('double-clicking empty lane space records a keyframe of the current pose', () => {
    const { editor, renderTL, keyAt, onTime, nodeId } = timelineHarness()
    const row = find(renderTL(), (v) => v.props?.['aria-label'] === `轨道 ${nodeId}`)
    row.props.onDoubleClick({
      target: { closest: () => null },
      currentTarget: { querySelector: () => lane },
      clientX: 140,
    })
    const track = editor.state.doc.animations![0].tracks.find((t) => t.nodeId === nodeId)!
    expect(track.keyframes.map((k) => k.timeMs)).toEqual([0, 500, 1000])
    expect(track.keyframes[1].value.kind).toBe('rectangle')
    expect(onTime).toHaveBeenLastCalledWith(500)
  })

  test('ruler ticks and keyframe positions are labeled and ratio-positioned', () => {
    const { renderTL, keyAt, nodeId } = timelineHarness()
    const tree = renderTL()
    expect(find(tree, (v) => v.props?.['aria-label'] === `轨道 ${nodeId}`)).toBeDefined()
    const first = keyAt(tree, 0)
    expect(first.props.style.left).toBe('0%')
    expect(keyAt(tree, 1000).props.style.left).toBe('100%')
    expect(first.props.className).toBe('animation-keyframe')
  })
})
