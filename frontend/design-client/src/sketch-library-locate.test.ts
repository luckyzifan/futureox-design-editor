import { expect, test } from 'vitest'
import { sketchLibraryGap, sketchOpenBlock } from './sketch-library-locate'

const missing = 'unsupported lossless conversion: Sketch instance requires an embedded symbol master: 6F0139C2-C417-4447-8E8B-5926F071C14F。这是缺失的外部库符号定义。位置：页面「USWDS Components」 / border color。修复：打开前定位并附上包含该 symbolID 的本地 .sketch 库。不会发明主组件。'

test('a missing Sketch symbol can be located and attached before open', () => {
  expect(sketchLibraryGap(missing)).toEqual({ kind: 'symbol', canAttach: true })
  expect(sketchOpenBlock(missing)?.kind).toBe('symbol')
})

test('a missing shared style stays distinct from an unmapped field', () => {
  const style = 'Sketch shared layerStyle `GONE-STYLE` is not embedded。这是缺失的外部库样式定义，不是无法映射的字段。位置：页面「Page」 / INSTANCE。不会发明样式。'
  expect(sketchLibraryGap(style)).toEqual({ kind: 'style', canAttach: true })
  expect(sketchOpenBlock('Sketch override `textStyle` has no supported editable mapping。这是无法映射的字段，不是缺失的外部库符号。')).toEqual({ kind: 'unmapped', canAttach: false })
})

test('a checked library that still lacks the symbol stays attachable but not ready', () => {
  const checked = missing.replace('打开前定位并附上包含该 symbolID 的本地 .sketch 库', '已核对本地库 uswds（documentID E3E47002）。其中没有这个 symbolID。上游定义缺失，打开保持阻断')
  expect(sketchLibraryGap(checked)?.canAttach).toBe(true)
  expect(checked).toContain('上游定义缺失')
  expect(sketchLibraryGap(checked)?.kind).toBe('symbol')
})

test('an unread over-budget library member is not treated as a located absence', () => {
  const unread = '已核对本地库 uswds。以下库成员超过现有条目上限，未展开，不能据此判定定义缺失：pages/avatars.json。'
  expect(sketchLibraryGap(`${missing} ${unread}`)?.canAttach).toBe(false)
  expect(sketchOpenBlock(`${missing} ${unread}`)?.kind).toBe('symbol')
})

test('corrupt override targets and ordinary failures do not offer a library attach', () => {
  const corrupt = 'Sketch override target `DF9F8712-F384-496A-AFFD-EE3744A1A99B` could not be resolved。这是损坏的覆盖引用，不是缺失的外部库符号，也不是无法映射的字段。不会发明图层。'
  expect(sketchLibraryGap(corrupt)).toBeNull()
  expect(sketchOpenBlock(corrupt)).toEqual({ kind: 'corrupt', canAttach: false })
  const unmapped = 'Sketch override `textStyle` has no supported editable mapping。这是无法映射的字段，不是缺失的外部库符号，也不是损坏的图层引用。'
  expect(sketchLibraryGap(unmapped)).toBeNull()
  expect(sketchOpenBlock(unmapped)).toEqual({ kind: 'unmapped', canAttach: false })
  expect(sketchOpenBlock('archive resource limit: entry expanded bytes')).toBeNull()
})
