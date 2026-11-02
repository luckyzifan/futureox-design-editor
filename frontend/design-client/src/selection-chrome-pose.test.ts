import { expect, test } from 'vitest'
import { rotationChromeHeldToTexture, rotationStartMemberCorners, rotationStartOutline } from './selection-chrome-pose'

const live = { id: 'live' }
const shown = { id: 'shown' }

test('rotation chrome stays on the presented texture until that texture is the live document', () => {
  expect(rotationChromeHeldToTexture({ kind: 'rotate', liveDocument: live, presentedDocument: shown, gestureFollow: false })).toBe(true)
  expect(rotationChromeHeldToTexture({ kind: 'rotate', liveDocument: live, presentedDocument: live, gestureFollow: false })).toBe(false)
  expect(rotationChromeHeldToTexture({ kind: 'rotate', liveDocument: live, presentedDocument: shown, gestureFollow: true })).toBe(false)
  expect(rotationChromeHeldToTexture({ kind: 'move', liveDocument: live, presentedDocument: shown, gestureFollow: false })).toBe(false)
  expect(rotationChromeHeldToTexture({ kind: 'rotate', liveDocument: live, presentedDocument: null, gestureFollow: false })).toBe(false)
})

test('the held outline is the start quad, not the live rotation', () => {
  const start = [0, 1, -1, 0, 10, 20] as [number, number, number, number, number, number]
  const members = rotationStartMemberCorners([{ id: 'a', width: 4, height: 2 }], { a: start })
  expect(members).toHaveLength(1)
  expect(rotationStartOutline(members!)).toEqual([
    { x: 10, y: 20 },
    { x: 10, y: 24 },
    { x: 8, y: 24 },
    { x: 8, y: 20 },
  ])
  expect(rotationStartMemberCorners([{ id: 'a', width: 4, height: 2 }], {})).toBeNull()
})
