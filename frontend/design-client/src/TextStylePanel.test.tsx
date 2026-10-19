import { afterEach, expect, test, vi } from 'vitest'
import React from 'react'
import { readFile } from 'node:fs/promises'
import { Editor } from './engine'
import { blank, node, validateDocument } from './model'
import { emptySystem } from './design-system'
import {
  TextStylePanel,
  parseCommaList,
  featuresIssue,
  fallbacksIssue,
  variationsIssue,
  variationTagValid,
  unmatchedSketchFonts,
} from './TextStylePanel'

// Deterministic component-handler boundary tests, using the same lightweight
// React internals harness as editor-lifecycle.test.tsx.
function harness() {
  const slots: any[] = [], effects: { fn: () => any; index: number }[] = []
  const layouts: { fn: () => any; index: number; cleanup?: () => void }[] = []
  let cursor = 0
  const hooks = {
    useContext() { cursor++; return undefined },
    useCallback(fn: (...args: any[]) => any) { const i = cursor++; return slots[i] ??= fn },
    useState(init: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useMemo(fn: () => any) { cursor++; return fn() },
    useSyncExternalStore(_: any, snapshot: () => any) { cursor++; return snapshot() },
    useLayoutEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || !old.deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        slots[i] = { deps }; layouts.push({ fn, index: i, cleanup: old?.cleanup })
      }
    },
    useEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || !old.deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
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
    effects() { for (const { fn, index } of effects.splice(0)) slots[index].cleanup = fn() },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()) },
  }
}
function find(tree: any, predicate: (value: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const value = find(child, predicate); if (value) return value }
}
const byLabel = (label: string) => (element: any) => element?.props?.['aria-label'] === label

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.dispose()))

// Document font resources must parse as real fonts kernel-side, so the panel
// tests embed the packaged Noto Sans SC once per suite.
let fontData = ''
async function loadFontFixture() {
  if (fontData) return
  const bytes = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)))
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  fontData = btoa(binary)
}

function fixture() {
  const doc = blank(), text = node('text', 20, 20, 200, 40)
  text.text = 'OpenType'
  doc.fonts = { font1: { family: 'Custom Sans', data: fontData } }
  doc.nodes[text.id] = text
  doc.pages[0].children = [text.id]
  const editor = new Editor(doc)
  editors.push(editor)
  return { editor, text }
}
function panel(f: ReturnType<typeof fixture>, h: ReturnType<typeof harness>) {
  return h.render(() =>
    TextStylePanel({ editor: f.editor, node: f.editor.state.doc.nodes[f.text.id], ids: [f.text.id] }),
  )
}

test('comma-list helpers mirror the kernel limits and drop empty items at save time', () => {
  expect(parseCommaList(' -liga , kern ,, ')).toEqual(['-liga', 'kern'])
  expect(featuresIssue(['kern'])).toBe('')
  expect(featuresIssue(Array.from({ length: 17 }, () => 'kern'))).toBe('特性最多 16 项')
  expect(featuresIssue(['a'.repeat(33)])).toContain('超过 32 字符')
  expect(variationTagValid('wdth')).toBe(true)
  expect(variationTagValid('wght')).toBe(false)
  expect(variationTagValid('wd')).toBe(false)
  expect(variationTagValid('wdt1')).toBe(true)
  expect(variationsIssue([{ tag: 'wght', value: '400' }])).toBe('wght 由字重字段控制')
  expect(variationsIssue([{ tag: 'wdt', value: '75' }])).toContain('4 位')
  expect(variationsIssue([{ tag: 'wdth', value: 'x' }])).toContain('数值无效')
  expect(variationsIssue([{ tag: '', value: '' }, { tag: 'wdth', value: '75' }])).toBe('')
  expect(fallbacksIssue(['font1', 'default'], { font1: {} as any })).toBe('')
  expect(fallbacksIssue(['missing'], { font1: {} as any })).toContain('不存在')
  expect(fallbacksIssue(Array.from({ length: 17 }, () => 'font1'), { font1: {} as any })).toContain('16 项')
})

test('the panel exposes the four new optional fields and stays minimal until edited', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  const tree = panel(f, h)
  for (const label of ['文字排版走向', 'OpenType 特性', '后备字体']) expect(find(tree, byLabel(label))).toBeTruthy()
  expect(find(tree, byLabel('添加变体轴'))).toBeTruthy()
  // Unset optional fields default to horizontal/empty without writing the doc.
  expect(find(tree, byLabel('文字排版走向')).props.value).toBe('horizontal')
  expect(find(tree, byLabel('OpenType 特性')).props.value).toBe('')
  expect(JSON.parse(JSON.stringify(f.editor.state.doc.nodes[f.text.id].textStyle ?? {}))).not.toHaveProperty('features')
})

test('features commits trimmed non-empty toggles and flags over-limit drafts inline', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  let tree = panel(f, h)
  const input = find(tree, byLabel('OpenType 特性'))
  input.props.onChange({ currentTarget: { value: ' -liga , kern , ,' } })
  tree = panel(f, h)
  find(tree, byLabel('OpenType 特性')).props.onBlur()
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.features).toEqual(['-liga', 'kern'])
  // An invalid draft keeps the red inline hint and never writes the doc.
  const invalid = Array.from({ length: 17 }, (_, i) => `f${i}`).join(',')
  tree = panel(f, h)
  find(tree, byLabel('OpenType 特性')).props.onChange({ currentTarget: { value: invalid } })
  tree = panel(f, h)
  expect(JSON.stringify(tree)).toContain('特性最多 16 项')
  find(tree, byLabel('OpenType 特性')).props.onBlur()
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.features).toEqual(['-liga', 'kern'])
  // Clearing the field removes the optional key entirely.
  tree = panel(f, h)
  find(tree, byLabel('OpenType 特性')).props.onChange({ currentTarget: { value: '' } })
  tree = panel(f, h)
  find(tree, byLabel('OpenType 特性')).props.onBlur()
  expect(JSON.stringify(f.editor.state.doc.nodes[f.text.id].textStyle)).not.toContain('"features"')
})

test('variation rows add, validate wght as reserved, and commit valid axes only', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  let tree = panel(f, h)
  find(tree, byLabel('添加变体轴')).props.onClick()
  tree = panel(f, h)
  find(tree, byLabel('变体轴标签 1')).props.onChange({ currentTarget: { value: 'wght' } })
  tree = panel(f, h)
  find(tree, byLabel('变体轴数值 1')).props.onChange({ currentTarget: { value: '700' } })
  tree = panel(f, h)
  expect(JSON.stringify(tree)).toContain('wght 由字重字段控制')
  find(tree, byLabel('变体轴标签 1')).props.onBlur()
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.variations).toBeUndefined()
  tree = panel(f, h)
  find(tree, byLabel('变体轴标签 1')).props.onChange({ currentTarget: { value: 'wdth' } })
  tree = panel(f, h)
  find(tree, byLabel('变体轴数值 1')).props.onBlur()
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.variations).toEqual([{ tag: 'wdth', value: 700 }])
  expect(validateDocument(structuredClone(f.editor.state.doc))).toBeTruthy()
})

test('writing mode toggles vertical and clearing returns to the unset default', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  let tree = panel(f, h)
  find(tree, byLabel('文字排版走向')).props.onChange({ target: { value: 'vertical' } })
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.writingMode).toBe('vertical')
  tree = panel(f, h)
  expect(find(tree, byLabel('文字排版走向')).props.value).toBe('vertical')
  find(tree, byLabel('文字排版走向')).props.onChange({ target: { value: 'horizontal' } })
  expect(JSON.stringify(f.editor.state.doc.nodes[f.text.id].textStyle)).not.toContain('writingMode')
})

test('fallbacks require known font resource ids before committing', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  let tree = panel(f, h)
  find(tree, byLabel('后备字体')).props.onChange({ currentTarget: { value: 'font1, missing' } })
  tree = panel(f, h)
  expect(JSON.stringify(tree)).toContain('missing 不存在')
  find(tree, byLabel('后备字体')).props.onBlur()
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.fallbacks).toEqual([])
  tree = panel(f, h)
  find(tree, byLabel('后备字体')).props.onChange({ currentTarget: { value: 'default, font1' } })
  tree = panel(f, h)
  find(tree, byLabel('后备字体')).props.onBlur()
  expect(f.editor.state.doc.nodes[f.text.id].textStyle?.fallbacks).toEqual(['default', 'font1'])
  expect(validateDocument(structuredClone(f.editor.state.doc))).toBeTruthy()
})

test('imported drafts re-sync when the committed value moves externally', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  let tree = panel(f, h)
  find(tree, byLabel('OpenType 特性')).props.onChange({ currentTarget: { value: 'draft-not-committed' } })
  // An external edit (undo, another panel) changes the committed features.
  f.editor.updateProperties([f.text.id], (n) => {
    n.textStyle = { ...n.textStyle!, features: ['ss01'] }
  }, '外部修改')
  tree = panel(f, h)
  h.effects()
  tree = panel(f, h)
  expect(find(tree, byLabel('OpenType 特性')).props.value).toBe('ss01')
  void tree
})

test('imported source fonts remain visibly unmatched until a real font replaces the fallback', async () => {
  await loadFontFixture()
  const f = fixture(), h = harness()
  f.editor.change('Import source font identities', doc => {
    doc.nodes[f.text.id].textRuns = [{ start: 0, end: 8, fontId: 'default', fontSize: 20, color: '#ffffff' }]
    doc.designSystem ??= emptySystem()
    doc.designSystem!.sketchContainers = { nodeMetadata: { [f.text.id]: { bindings: {
      sketchSourceFonts: JSON.stringify({ runs: { 0: 'YouSheBiaoTiHei' } }),
    } } } }
  })
  let tree = panel(f, h)
  expect(JSON.stringify(find(tree, byLabel('原字体匹配状态')))).toContain('YouSheBiaoTiHei')
  find(tree, byLabel('文字字体')).props.onChange({ target: { value: 'font1' } })
  tree = panel(f, h)
  expect(find(tree, byLabel('原字体匹配状态'))).toBeUndefined()
  expect(f.editor.state.doc.nodes[f.text.id].textRuns?.[0]).toEqual({ start: 0, end: 8, fontSize: 20, color: '#ffffff' })
  expect(unmatchedSketchFonts(f.editor.state.doc, f.editor.state.doc.nodes[f.text.id])).toEqual([])
})
