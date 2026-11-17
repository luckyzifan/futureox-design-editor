import { beforeEach, expect, test, vi } from 'vitest'
import { ImportOwner } from '../import-ownership'
import { takeWarmFigCanvas, warmFigCanvas } from './fig-canvas-warmup'

const { warm, dispose } = vi.hoisted(() => ({ warm: vi.fn(async () => {}), dispose: vi.fn() }))
vi.mock('./client', () => ({
  canWarmDesktopCanvas: () => true,
  KernelClient: class {
    warmCanvasPreparation = warm
    dispose = dispose
  },
}))

function editorFixture() {
  const listeners = new Set<() => void>()
  return {
    sessionGeneration: 1,
    state: { doc: { id: 'home' } },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    adopt(id: string) {
      this.sessionGeneration++
      this.state.doc = { id }
      for (const listener of listeners) listener()
    },
  }
}

beforeEach(() => { warm.mockClear(); dispose.mockClear() })

test('only the adopted FIG on that editor takes the warmed preparation owner', () => {
  const editor = editorFixture()
  const request = new ImportOwner().begin(editor)
  const lease = warmFigCanvas(editor, request)!
  expect(takeWarmFigCanvas(editor, 'first-fig')).toBeUndefined()
  lease.bind('first-fig')
  editor.adopt('first-fig')
  expect(request.signal.aborted).toBe(true)
  expect(takeWarmFigCanvas({}, 'first-fig')).toBeUndefined()
  expect(takeWarmFigCanvas(editor, 'other-file')).toBeUndefined()
  expect(takeWarmFigCanvas(editor, 'first-fig')).toBeDefined()
  expect(takeWarmFigCanvas(editor, 'first-fig')).toBeUndefined()
  lease.finish(true)
  request.finish()
  expect(warm).toHaveBeenCalledTimes(1)
  expect(dispose).not.toHaveBeenCalled()
})

test('cancellation and a superseded adoption retire their unclaimed workers', () => {
  const editor = editorFixture(), imports = new ImportOwner()
  const request = imports.begin(editor)
  const lease = warmFigCanvas(editor, request)!
  imports.invalidate()
  lease.finish(false)
  expect(dispose).toHaveBeenCalledTimes(1)

  const next = imports.begin(editor)
  const latest = warmFigCanvas(editor, next)!
  latest.bind('first-fig')
  const replacement = imports.begin(editor)
  expect(takeWarmFigCanvas(editor, 'first-fig')).toBeUndefined()
  latest.finish(false)
  replacement.finish()
  expect(dispose).toHaveBeenCalledTimes(2)
})
