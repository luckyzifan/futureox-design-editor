// Issue #872. The text-2026-10-09 case set must carry the Figma typography the
// generator writes: 140% line boxes, 2.5 / -0.75 tracking, and the 30/18 styled
// run. These assertions bind the fixture to the kernel layout facts, not to
// this renderer's own pixels. Official Figma 1x/2x PNGs are not in the tree, so
// pixel parity stays NOT_RUN and is never asserted here.
import { readFileSync, existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { kernelTextLayout } from './kernel/picking'
import type { DesignNode } from './model'

type Case = { id: string; document: { nodes: Record<string, DesignNode> } }
const cases: Case[] = JSON.parse(
  readFileSync(new URL('../public/fidelity/text-2026-10-09/cases.json', import.meta.url), 'utf8'),
)
const nodeOf = (id: string, nodeId: string) => {
  const found = cases.find(item => item.id === id)?.document.nodes[nodeId]
  expect(found, `${id}/${nodeId}`).toBeTruthy()
  return found
}
const withStyle = (node: DesignNode, patch: Partial<NonNullable<DesignNode['textStyle']>>): DesignNode => ({
  ...node,
  textStyle: { ...node.textStyle, ...patch },
})

test('the case file keeps camelCase Figma typography and never falls back to snake_case', () => {
  const raw = readFileSync(new URL('../public/fidelity/text-2026-10-09/cases.json', import.meta.url), 'utf8')
  expect(raw).not.toContain('text_style')
  expect(raw).not.toContain('text_runs')
  const multiline = nodeOf('text-multiline', 'm1')
  expect(multiline.textStyle).toMatchObject({ lineHeight: 1.4, lineBoxBaseline: 'figma-pixel-leading' })
  const tracked = nodeOf('text-letter-spacing', 'l1')
  expect(tracked.textStyle?.letterSpacing).toBe(2.5)
  const tight = nodeOf('text-letter-spacing', 'l2')
  expect(tight.textStyle?.letterSpacing).toBe(-0.75)
  const runs = nodeOf('text-styled-runs', 'r1')
  expect(runs.textRuns).toEqual([
    { start: 0, end: 6, fontSize: 30, color: '#c0392b' },
    { start: 6, end: 17, fontSize: 18 },
  ])
})

test('the 140% line box drives real kernel line pitch instead of the 1.35 default', () => {
  const multiline = nodeOf('text-multiline', 'm1')
  const explicit = kernelTextLayout(multiline)
  const auto = kernelTextLayout(withStyle(multiline, {
    lineHeight: undefined,
    lineHeightAuto: true,
    lineBoxBaseline: 'figma-font-metrics',
  }))
  expect(explicit.lines.length).toBe(3)
  expect(auto.lines.length).toBe(3)
  const pitch = (layout: typeof explicit) => layout.lines.slice(1).map((line, index) => line.y - layout.lines[index].y)
  for (const step of pitch(explicit)) expect(Math.abs(step - 25.2)).toBeLessThan(0.51)
  expect(Math.abs(explicit.height - 75.6)).toBeLessThan(0.51)
  // The bundled default font's Auto pitch is not 25.2, so the authored 140%
  // line box is what produced the explicit heights above.
  expect(pitch(auto).some(step => Math.abs(step - 25.2) > 0.5)).toBe(true)
})

test('positive and negative tracking move the measured advance in the authored direction', () => {
  const tracked = nodeOf('text-letter-spacing', 'l1')
  const tight = nodeOf('text-letter-spacing', 'l2')
  const trackedWidth = kernelTextLayout(tracked).width
  const trackedZero = kernelTextLayout(withStyle(tracked, { letterSpacing: 0 })).width
  const tightWidth = kernelTextLayout(tight).width
  const tightZero = kernelTextLayout(withStyle(tight, { letterSpacing: 0 })).width
  // 14 inter-glyph gaps × 2.5 px; the exact cluster count is not the contract.
  expect(trackedWidth - trackedZero).toBeGreaterThan(20)
  expect(trackedWidth - trackedZero).toBeLessThan(40)
  // "Tight run" has nine clusters, so eight inter-glyph gaps at -0.75 px.
  expect(tightZero - tightWidth).toBeGreaterThan(5)
  expect(tightZero - tightWidth).toBeLessThan(8)
})

test('the styled-run sizes and color survive into the shaped glyphs', () => {
  const runs = nodeOf('text-styled-runs', 'r1')
  const layout = kernelTextLayout(runs)
  const sizes = new Set(layout.glyphs.map(glyph => glyph.size))
  expect(sizes.has(30)).toBe(true)
  expect(sizes.has(18)).toBe(true)
  expect(layout.glyphs.filter(glyph => glyph.size === 30).length).toBeGreaterThan(0)
  expect(layout.glyphs.filter(glyph => glyph.size === 18).length).toBeGreaterThan(0)
  expect(layout.spans.some(span => span.color?.toLowerCase() === '#c0392b')).toBe(true)
  const uniform = kernelTextLayout({ ...runs, textRuns: undefined, fontSize: 24 })
  expect(layout.height).not.toBe(uniform.height)
})

test('official Figma 1x and 2x text references are still absent from the tree', () => {
  const directory = new URL('../public/fidelity/text-2026-10-09/', import.meta.url)
  const missing = cases.flatMap(item => [1, 2].map(scale => {
    const name = `KernelTextQA-${item.id}${scale === 2 ? '@2x' : ''}.png`
    return { name, present: existsSync(new URL(name, directory)) }
  })).filter(entry => !entry.present).map(entry => entry.name)
  // This is the issue's measured NOT_RUN condition: the generator exists but
  // no official export was committed, so no pixel comparison may be claimed.
  console.info(`FIGMA_TEXT_REFERENCES NOT_RUN: ${missing.length}/${cases.length * 2} PNGs absent`)
  expect(missing.length).toBeGreaterThan(0)
})