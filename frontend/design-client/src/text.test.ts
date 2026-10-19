import { expect, test } from 'vitest'
import { applyWholeTextStyle, clearWholeTextRunColor, replaceText, setWholeTextFontSize, styleTextRange } from './text'
import { node, validateDocument, blank, copyName, defaultTextStyle } from './model'
test('text replacement preserves surrounding runs and inherits inserted text style', () => {
  const n = node('text')
  n.text = 'abcdef'
  n.textRuns = [{ start: 1, end: 5, weight: 700 }]
  replaceText(n, 'abXYZef')
  expect(n.textRuns).toEqual([
    { start: 1, end: 2, weight: 700 },
    { start: 2, end: 5, weight: 700 },
    { start: 5, end: 6, weight: 700 },
  ])
  const d = blank()
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  expect(validateDocument(d)).toBe(d)
})
test('combining input never leaves a style boundary inside a grapheme', () => {
  const n = node('text')
  n.text = 'ex'
  n.textRuns = [{ start: 0, end: 1, weight: 700 }]
  replaceText(n, 'e\u0301x')
  expect(n.textRuns).toEqual([{ start: 0, end: 2, weight: 700 }])
})
test('copy names retain complete Unicode scalars and invalid UTF-16 cannot be saved', () => {
  const title = copyName('😀'.repeat(100), ' 副本')
  expect(title.length).toBeLessThanOrEqual(200)
  expect(validateDocument(blank(title)).name).toBe(title)
  expect(() => validateDocument({ ...blank(), name: '\ud800' })).toThrow()
})

test('whole-layer font and size changes retain unrelated range formatting', () => {
  const n = node('text')
  n.text = 'abcdef'
  n.textStyle = { ...defaultTextStyle(), fontId: 'old-font', weight: 400 }
  n.textRuns = [
    { start: 0, end: 3, fontId: 'default', fontSize: 40, weight: 700, color: '#ff0000', underline: true },
    { start: 3, end: 6, fontId: 'old-font', fontSize: 32, weight: 500, link: 'https://example.com', strikethrough: true },
  ]
  const originalRuns = structuredClone(n.textRuns)
  applyWholeTextStyle(n, { align: 'center' })
  expect(n.textRuns).toEqual(originalRuns)
  applyWholeTextStyle(n, { fontId: 'new-font' })
  expect(n.textStyle.fontId).toBe('new-font')
  expect(n.textRuns).toEqual(originalRuns.map(({ fontId: _fontId, ...run }) => run))
  setWholeTextFontSize(n, 64)
  expect(n.fontSize).toBe(64)
  expect(n.textRuns).toEqual(originalRuns.map(({ fontId: _fontId, fontSize: _fontSize, ...run }) => run))
  applyWholeTextStyle(n, { weight: 600 })
  expect(n.textRuns).toEqual([
    { start: 0, end: 3, color: '#ff0000', underline: true },
    { start: 3, end: 6, link: 'https://example.com', strikethrough: true },
  ])
  styleTextRange(n, 1, 2, { fontSize: 20, fontId: 'range-font' })
  expect(n.textRuns?.find(run => run.start === 1 && run.end === 2)).toMatchObject({ fontSize: 20, fontId: 'range-font', color: '#ff0000', underline: true })
  expect(n.fontSize).toBe(64)
  expect(n.textStyle.fontId).toBe('new-font')
})

test('whole-text formatting leaves non-text layers unchanged', () => {
  const n = node('rectangle'), before = structuredClone(n)
  applyWholeTextStyle(n, { fontId: 'font', weight: 700 })
  setWholeTextFontSize(n, 80)
  clearWholeTextRunColor(n)
  expect(n).toEqual(before)
})

test('whole-layer fill editing removes only ranged color overrides', () => {
  const n = node('text')
  n.text = 'abc'
  n.textRuns = [{ start: 0, end: 3, fontId: 'default', fontSize: 40, weight: 700, color: '#ffffff', underline: true, link: 'https://example.com' }]
  clearWholeTextRunColor(n)
  expect(n.textRuns).toEqual([{ start: 0, end: 3, fontId: 'default', fontSize: 40, weight: 700, underline: true, link: 'https://example.com' }])
})
