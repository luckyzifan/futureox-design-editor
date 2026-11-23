import { expect, test } from 'vitest'
import { altMeasurementTarget, anchorPlacementBox, diagramFromLines, DISTANCE_PILL_BASELINE_LEAD, DISTANCE_PILL_EXTRA_HEIGHT, DISTANCE_PILL_FONT_SIZE, DISTANCE_PILL_GAP, DISTANCE_PILL_PAD_X, guidePositionReadout, measureAnchors, measureBounds, measureToGuide, measurementLabel, measurementTicks, readoutAtPoint, selectionChromeChipWidth, spacingDiagram, spacingInteraction, SPACING_RED } from './canvas-measurements'
test('nested layer measurements report all four exact margins', () => {
  const outer = { x: 10, y: 20, width: 300, height: 200 }, inner = { x: 40, y: 65, width: 50, height: 60 }
  expect(measureBounds(inner, outer).map(item => item.distance)).toEqual([30, 220, 45, 95])
  expect(measureBounds(outer, inner)).toEqual(measureBounds(inner, outer))
  expect(measureBounds(inner, outer).map(item => item.axis)).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical'])
})
test('separate layers measure edge gaps without counting shape widths', () => {
  const selection = { x: 0, y: 0, width: 100, height: 50 }, target = { x: 120, y: 60, width: 80, height: 40 }
  const lines = measureBounds(selection, target)
  expect(lines.map(item => item.distance)).toEqual([20, 10])
  expect(lines[0]).toMatchObject({ from: { x: 100, y: 50 }, to: { x: 120, y: 50 }, axis: 'horizontal' })
  expect(lines[1]).toMatchObject({ from: { x: 100, y: 50 }, to: { x: 100, y: 60 }, axis: 'vertical' })
})
test('a shared perpendicular span centers the gap and omits the overlapping axis', () => {
  const selection = { x: 0, y: 0, width: 100, height: 50 }, target = { x: 130, y: 10, width: 40, height: 20 }
  const lines = measureBounds(selection, target)
  expect(lines).toEqual([{ from: { x: 100, y: 20 }, to: { x: 130, y: 20 }, distance: 30, axis: 'horizontal' }])
})
test('partial overlap measures the four matching edges', () => {
  const selection = { x: 0, y: 0, width: 80, height: 40 }
  const target = { x: 40, y: 10, width: 80, height: 40 }
  expect(measureBounds(selection, target)).toEqual([
    { from: { x: 0, y: 25 }, to: { x: 40, y: 25 }, distance: 40, axis: 'horizontal' },
    { from: { x: 80, y: 25 }, to: { x: 120, y: 25 }, distance: 40, axis: 'horizontal' },
    { from: { x: 60, y: 0 }, to: { x: 60, y: 10 }, distance: 10, axis: 'vertical' },
    { from: { x: 60, y: 40 }, to: { x: 60, y: 50 }, distance: 10, axis: 'vertical' },
  ])
  const diagram = spacingDiagram(selection, target, 1)
  expect(diagram.pills.map(pill => pill.text).sort()).toEqual(['10', '10', '40', '40'])
  expect(diagram.lines.some(line => line.role === 'box')).toBe(true)
  expect(diagram.lines.filter(line => line.role === 'gap')).toHaveLength(4)
})
test('end ticks stay six CSS pixels and padding labels clear the line', () => {
  const line = measureBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 18, y: 0, width: 10, height: 10 })[0]
  expect(measurementTicks(line, 2)).toEqual([
    [{ x: 10, y: 5 - 1.5 }, { x: 10, y: 5 + 1.5 }],
    [{ x: 18, y: 5 - 1.5 }, { x: 18, y: 5 + 1.5 }],
  ])
  expect(measurementLabel(line, 2).offset).toEqual({ x: 0, y: -16 })
  expect(measurementLabel({ ...line, distance: 40 }, 2).offset).toEqual({ x: 0, y: -6 })
  const padding = { ...line, role: 'padding' as const }
  const below = DISTANCE_PILL_GAP + DISTANCE_PILL_FONT_SIZE + DISTANCE_PILL_BASELINE_LEAD
  expect(measurementLabel(padding, 2).offset).toEqual({ x: 0, y: below })
  const vertical = { from: { x: 0, y: 0 }, to: { x: 0, y: 40 }, distance: 40, axis: 'vertical' as const, role: 'padding' as const }
  const boxW = selectionChromeChipWidth('40', DISTANCE_PILL_FONT_SIZE) + DISTANCE_PILL_PAD_X * 2
  const boxH = DISTANCE_PILL_FONT_SIZE + DISTANCE_PILL_EXTRA_HEIGHT
  expect(measurementLabel(vertical, 1).offset).toEqual({
    x: DISTANCE_PILL_GAP + boxW / 2,
    y: DISTANCE_PILL_FONT_SIZE + DISTANCE_PILL_BASELINE_LEAD - boxH / 2,
  })
})
test('padding guides end on the box edges and their pills sit below or to the right', () => {
  const diagram = spacingDiagram({ x: 0, y: 0, width: 200, height: 160 }, { x: 40, y: 30, width: 50, height: 40 }, 1)
  const padding = diagram.lines.filter(line => line.role === 'padding')
  expect(padding).toHaveLength(4)
  expect(padding.every(line => line.tick === false)).toBe(true)
  const horizontal = diagram.pills.find(pill => pill.text === '40')
  const vertical = diagram.pills.find(pill => pill.text === '30')
  expect(horizontal?.offset.y).toBeGreaterThan(0)
  expect(horizontal?.offset.x).toBe(0)
  expect(vertical?.offset.x).toBeGreaterThan(0)
})
test('a 1px gap labels both widths and repeats the gap at each end of the seam', () => {
  const diagram = spacingDiagram({ x: 0, y: 0, width: 48, height: 40 }, { x: 49, y: 0, width: 50, height: 40 }, 1)
  expect(diagram.pills.map(pill => pill.text).sort()).toEqual(['1', '1', '48', '50'])
  expect(diagram.lines.some(line => line.role === 'box')).toBe(true)
  expect(diagram.lines.some(line => line.role === 'span')).toBe(true)
  const wide = spacingDiagram({ x: 0, y: 0, width: 20, height: 10 }, { x: 50, y: 0, width: 20, height: 10 }, 1)
  expect(wide.pills.filter(pill => pill.text === '30')).toHaveLength(1)
})
test('Alt measures the hovered layer, not the selection, and stays off during drag or Space', () => {
  expect(SPACING_RED).toBe('#e05634')
  const selected = 'a', sibling = 'b'
  expect(altMeasurementTarget({
    alt: true, dragging: false, space: false, tool: 'select', selection: [selected], hover: sibling,
  })).toBe(sibling)
  expect(altMeasurementTarget({
    alt: true, dragging: false, space: false, tool: 'select', selection: [selected], hover: selected,
  })).toBeNull()
  expect(altMeasurementTarget({
    alt: false, dragging: false, space: false, tool: 'select', selection: [selected], hover: sibling,
  })).toBeNull()
  expect(altMeasurementTarget({
    alt: true, dragging: true, space: false, tool: 'select', selection: [selected], hover: sibling,
  })).toBeNull()
  expect(altMeasurementTarget({
    alt: true, dragging: false, space: true, tool: 'select', selection: [selected], hover: sibling,
  })).toBeNull()
  expect(altMeasurementTarget({
    alt: true, dragging: false, space: false, tool: 'hand', selection: [selected], hover: sibling,
  })).toBeNull()
  expect(altMeasurementTarget({
    alt: true, dragging: false, space: false, tool: 'select', selection: [], hover: sibling,
  })).toBeNull()
  expect(altMeasurementTarget({
    alt: false, inspect: true, dragging: false, space: false, tool: 'select', selection: [selected], hover: sibling,
  })).toBe(sibling)
  expect(altMeasurementTarget({
    alt: false, inspect: true, dragging: true, space: false, tool: 'select', selection: [selected], hover: sibling,
  })).toBeNull()
})
test('a ruler guide is one gap outside the box and both sides when it crosses', () => {
  const box = { x: 0, y: 10, width: 40, height: 20 }
  expect(measureToGuide(box, { axis: 'x', position: 70 }).map(item => item.distance)).toEqual([30])
  expect(measureToGuide(box, { axis: 'x', position: 16 }).map(item => item.distance)).toEqual([16, 24])
  expect(measureToGuide(box, { axis: 'y', position: 4 })[0]).toMatchObject({ from: { x: 20, y: 4 }, to: { x: 20, y: 10 }, axis: 'vertical' })
})
test('two guides report axis positions and no spacing line', () => {
  expect(guidePositionReadout([120, 340.5], { x: 10, y: 20 }).map(pill => pill.text)).toEqual(['120', '340.5'])
})
test('vector anchors measure both axes, and a new point previews a dashed box', () => {
  expect(measureAnchors({ x: 0, y: 0 }, { x: 30, y: 12 }).map(item => [item.distance, item.axis])).toEqual([[30, 'horizontal'], [12, 'vertical']])
  expect(measureAnchors({ x: 0, y: 4 }, { x: 8, y: 4 })).toHaveLength(1)
  const placed = anchorPlacementBox({ x: 0, y: 0 }, { x: 20, y: 10 })
  expect(placed.lines.every(line => line.dash && line.role === 'box')).toBe(true)
  expect(placed.pills.map(pill => pill.text).sort()).toEqual(['10', '20'])
  expect(diagramFromLines(measureAnchors({ x: 0, y: 0 }, { x: 8, y: 0 }), 1).pills.map(pill => pill.text)).toEqual(['8'])
})
test('Dev Mode hover, keyboard pick, guides, and anchors choose one measurement', () => {
  const base = {
    tool: 'select', alt: false, inspect: false, dragging: false, space: false, selection: ['a'],
    hover: 'b', pick: null, guideHover: false, guideMeasurable: false, guidePair: false,
    vectorAnchor: false, vectorPlace: false,
  }
  expect(spacingInteraction(base)).toBeNull()
  expect(spacingInteraction({ ...base, inspect: true })).toEqual({ kind: 'layers', id: 'b' })
  expect(spacingInteraction({ ...base, alt: true, pick: 'c' })).toEqual({ kind: 'layers', id: 'c' })
  expect(spacingInteraction({ ...base, alt: true, pick: 'a' })).toEqual({ kind: 'layers', id: 'b' })
  expect(spacingInteraction({ ...base, alt: true, guideHover: true, guideMeasurable: true })).toEqual({ kind: 'guide' })
  expect(spacingInteraction({ ...base, guidePair: true })).toEqual({ kind: 'guide-positions' })
  expect(spacingInteraction({ ...base, inspect: true, guideHover: true })).toBeNull()
  expect(spacingInteraction({ ...base, tool: 'vector', alt: true, vectorAnchor: true })).toEqual({ kind: 'anchors' })
  expect(spacingInteraction({ ...base, tool: 'vector', alt: true, vectorPlace: true })).toEqual({ kind: 'anchor-place' })
  expect(spacingInteraction({ ...base, tool: 'vector', alt: true, vectorAnchor: true, vectorPlace: true })).toEqual({ kind: 'anchors' })
  expect(spacingInteraction({ ...base, alt: true, dragging: true, guidePair: true })).toBeNull()
})
test('Space repeats the measurement under the pointer and ignores the box outline', () => {
  const lines = spacingDiagram({ x: 0, y: 0, width: 20, height: 10 }, { x: 50, y: 0, width: 20, height: 10 }, 1).lines
  const gap = lines.find(line => line.role === 'gap')!
  expect(readoutAtPoint(lines, [], { x: (gap.from.x + gap.to.x) / 2, y: gap.from.y }, 1)).toBe('30')
  const edge = lines.find(line => line.role === 'box')!
  expect(readoutAtPoint([edge], [], { x: (edge.from.x + edge.to.x) / 2, y: edge.from.y }, 1)).toBeNull()
  expect(readoutAtPoint([], [{ text: '120', anchor: { x: 4, y: 4 }, offset: { x: 0, y: 0 } }], { x: 4, y: 4 }, 1)).toBe('120')
})
