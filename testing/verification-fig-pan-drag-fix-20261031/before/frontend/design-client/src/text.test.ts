import { expect, test } from 'vitest'
import { applyWholeTextStyle, clearWholeTextRunColor, replaceText, replaceTextRange, setWholeTextFontSize, styleTextRange } from './text'
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
test('explicit replacement does not relocate deletion within repeated substrings', () => {
  const n = node('text'); n.text = 'aaaa'
  n.textRuns = [100, 200, 300, 400].map((weight, start) => ({ start, end: start + 1, weight }))
  replaceTextRange(n, 0, 1, '')
  expect(n.text).toBe('aaa')
  expect(n.textRuns).toEqual([200, 300, 400].map((weight, start) => ({ start, end: start + 1, weight })))
})
test('explicit insertion uses the right-hand style, layer defaults in gaps, and the preceding style only at EOF', () => {
  for (const [position, weight] of [[0, 100], [1, 200], [2, undefined], [3, 400], [4, 400]] as const) {
    const n = node('text'); n.text = 'abcd'
    n.textRuns = [{ start: 0, end: 1, weight: 100 }, { start: 1, end: 2, weight: 200 }, { start: 3, end: 4, weight: 400 }]
    replaceTextRange(n, position, position, 'XY')
    const inserted = n.textRuns?.find(run => run.start === position && run.end === position + 2)
    expect(inserted?.weight).toBe(weight)
    if (weight === undefined) expect(inserted).toBeUndefined()
    const d = blank(); d.nodes[n.id] = n; d.pages[0].children = [n.id]
    expect(validateDocument(d)).toBe(d)
  }
  const empty = node('text'); empty.text = ''; replaceTextRange(empty, 0, 0, '👩‍💻')
  expect(empty.text).toBe('👩‍💻'); expect(empty.textRuns).toBeUndefined()
})
test('explicit replacement preserves mixed outside attributes and is a true no-op for identical text', () => {
  const n = node('text'); n.text = 'abcdef'
  n.textRuns = [{ start: 0, end: 2, weight: 700, underline: true }, { start: 2, end: 4, weight: 300 }, { start: 4, end: 6, link: 'https://example.com' }]
  const before = structuredClone(n)
  replaceTextRange(n, 1, 5, 'bcde'); expect(n).toEqual(before)
  replaceTextRange(n, 1, 5, 'XY')
  expect(n.text).toBe('aXYf')
  expect(n.textRuns).toEqual([{ start: 0, end: 1, weight: 700, underline: true }, { start: 1, end: 3, weight: 700, underline: true }, { start: 3, end: 4, link: 'https://example.com' }])
})
test('explicit replacement rejects grapheme splits, cross-edge joins and malformed or oversized text before mutating', () => {
  const cases: [string, number, number, string][] = [
    ['👩‍💻', 0, 2, 'x'], ['é', 0, 1, 'x'], ['😀', 1, 2, 'x'],
    ['ex', 1, 1, '\u0301'], ['👩💻', 2, 2, '\u200d'], ['🇦x🇧', 2, 3, ''],
    ['abc', 2, 1, 'x'], ['abc', 0, 4, 'x'], ['abc', .5, 1, 'x'],
    ['abc', 0, 0, '\ud800'], ['abc', 0, 0, '\udfff'], ['a'.repeat(100000), 0, 0, 'a'],
  ]
  for (const [text, start, end, inserted] of cases) {
    const n = node('text'); n.text = text; const before = structuredClone(n)
    expect(() => replaceTextRange(n, start, end, inserted)).toThrow(); expect(n).toEqual(before)
  }
  const n = node('text'); n.text = 'é'; replaceTextRange(n, 0, 2, 'ó')
  expect(n.text).toBe('ó')
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
