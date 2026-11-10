import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SketchLibraryLocate } from './SketchLibraryLocate'

const missing = 'unsupported lossless conversion: Sketch instance requires an embedded symbol master: 6F0139C2-C417-4447-8E8B-5926F071C14F。这是缺失的外部库符号定义。修复：打开前定位并附上包含该 symbolID 的本地 .sketch 库。不会发明主组件。'

test('the locate card keeps the symbol diagnosis and an attach control', () => {
  const html = renderToStaticMarkup(<SketchLibraryLocate block={{ kind: 'symbol', canAttach: true }} error={missing} busy={false} onClose={() => undefined} onAttach={async () => undefined} />)
  expect(html).toContain('缺少外部符号')
  expect(html).toContain('6F0139C2')
  expect(html).toContain('选择本地 Sketch 库')
  expect(html).toContain('按 ID 核对并重新打开')
  expect(html).toContain('文件保持未打开')
})

test('corrupt references and unread library members do not offer another attach', () => {
  const corrupt = renderToStaticMarkup(<SketchLibraryLocate block={{ kind: 'corrupt', canAttach: false }} error="Sketch override target `DF9F8712-F384-496A-AFFD-EE3744A1A99B` could not be resolved。这是损坏的覆盖引用。" busy={false} onClose={() => undefined} onAttach={async () => undefined} />)
  expect(corrupt).toContain('损坏的覆盖引用')
  expect(corrupt).not.toContain('选择本地 Sketch 库')
  const unread = renderToStaticMarkup(<SketchLibraryLocate block={{ kind: 'symbol', canAttach: false }} error={`${missing} 未展开，不能据此判定定义缺失：pages/avatars.json。`} busy={false} onClose={() => undefined} onAttach={async () => undefined} />)
  expect(unread).toContain('不会提高上限')
  expect(unread).not.toContain('选择本地 Sketch 库')
})

test('the open callback does not read library bytes before the shared size check', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('<SketchLibraryLocate')
  const slice = source.slice(start, start + 1800)
  expect(start).toBeGreaterThan(0)
  expect(slice).toContain('importSketchWithLibraries(libraryGap.file, libraries')
  expect(slice).not.toContain('arrayBuffer')
})
