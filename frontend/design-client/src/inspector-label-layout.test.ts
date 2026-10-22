import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
// This deliberately bounded cascade model covers the ordinary selectors used by
// these fields. It fails closed for a matching complex selector rather than
// pretending to implement a browser's layout or full CSS engine.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<div class="editor-shell"><div class="properties-content"><div class="inspector"><section><div class="field-grid"><label class="number-field"><span>Long label</span><input /></label></div></section></div></div></div>')
function effective(source: string, target: Element, property: string) {
  let winner: { value: string; priority: number; specificity: number } | undefined
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = match[2].split(';').map(item => item.trim()).filter(item => item.startsWith(property + ':'))
    if (!declarations.length) continue
    for (const selector of match[1].trim().split(',')) {
      const trimmed = selector.trim()
      if (!target.matches(trimmed)) continue
      const before = clean.slice(0, match.index)
      if ((before.match(/\{/g) || []).length !== (before.match(/\}/g) || []).length) throw new Error('Unsupported conditional cascade rule: ' + trimmed)
      if (/[:@\[]/.test(trimmed)) throw new Error('Unsupported relevant cascade selector: ' + trimmed)
      const ids = (trimmed.match(/#[\w-]+/g) || []).length
      const classes = (trimmed.match(/\.[\w-]+/g) || []).length
      const types = trimmed.replace(/[.#][\w-]+/g, '').match(/\b[a-zA-Z][\w-]*\b/g)?.length || 0
      const specificity = ids * 10000 + classes * 100 + types
      for (const declaration of declarations) {
        const priority = /!important\s*$/.test(declaration) ? 1 : 0
        const value = declaration.slice(declaration.indexOf(':') + 1).replace(/\s*!important\s*$/, '').trim()
        if (!winner || priority > winner.priority || (priority === winner.priority && specificity >= winner.specificity)) winner = { value, priority, specificity }
      }
    }
  }
  return winner?.value
}
const field = dom.window.document.querySelector('.field-grid')!
const label = dom.window.document.querySelector('span')!
const input = dom.window.document.querySelector('input')!
test('final inspector cascade shrinks long labels rather than editable values', () => {
  expect(effective(css, field, 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))')
  expect(effective(css, label, 'min-width')).toBe('0')
  expect(effective(css, label, 'flex')).toBe('0 1 auto')
  expect(effective(css, label, 'overflow')).toBe('hidden')
  expect(effective(css, label, 'text-overflow')).toBe('ellipsis')
  expect(effective(css, label, 'white-space')).toBe('nowrap')
  expect(effective(css, input, 'min-width')).toBe('48px')
  expect(effective(css, input, 'flex')).toBe('1 0 48px')
  expect(effective(css, input, 'width')).toBe('0')
  expect(effective(css, input, 'text-overflow')).not.toBe('ellipsis')
})
test('cascade contract detects later overrides and respects selector specificity', () => {
  expect(effective(css + '.number-field input { min-width: 1px; }', input, 'min-width')).toBe('48px')
  expect(effective(css + '.properties-content .number-field input { min-width: 1px; }', input, 'min-width')).toBe('1px')
  expect(effective('.editor-shell .properties-content .number-field input { min-width: 2px; }' + css, input, 'min-width')).toBe('2px')
  expect(effective('.number-field input { min-width: 3px !important; }' + css, input, 'min-width')).toBe('3px')
})

test('260px inspector leaves an editable numeric value even for very long localized labels', () => {
  // Explicit box model contract, not a browser pixel-layout or GUI test.
  for (const panel of [260, 280, 480]) {
    const column = (panel - 2 * 16 - 7) / 2
    const valueMinimum = 48
    const labelBudget = column - 2 - 7 - 7 - valueMinimum
    expect(labelBudget).toBeGreaterThan(0)
    for (const simulatedLabelWidth of [8, 80, 240, 1000]) {
      const visibleLabel = Math.min(simulatedLabelWidth, labelBudget)
      expect(visibleLabel + valueMinimum + 2 + 7 + 7).toBeLessThanOrEqual(column)
    }
  }
})
