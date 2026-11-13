import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { ALL_ASSETS_HIDDEN_REASON, ALL_ASSETS_ROUND_TRIP_REASON, allAssetPath, planAllAssets } from './all-assets-plan'
import { matchesAllAssetsShortcut } from './all-assets-shortcut'
import { fileMenuText } from './file-menu-messages'
import { blank, node, paint, uid, type DesignDocument } from './model'

function issueFixture(): { doc: DesignDocument; rectId: string; ellipseId: string; pageId: string } {
  const doc = blank('assets')
  doc.schemaVersion = 10
  const rect = node('rectangle', 0, 0, 40, 30)
  const ellipse = node('ellipse', 80, 10, 20, 16)
  rect.name = '矩形'
  ellipse.name = '椭圆'
  rect.fills = [paint('#e11d48')]
  ellipse.fills = [paint('#2563eb')]
  rect.exportSettings = [
    { id: 'rect-png', format: 'png', scale: 1, suffix: '@one' },
    { id: 'rect-svg', format: 'svg', scale: 1, suffix: '@vector' },
  ]
  ellipse.exportSettings = [
    { id: 'ell-png', format: 'png', scale: 1, suffix: '@one' },
    { id: 'ell-svg', format: 'svg', scale: 1, suffix: '@vector' },
  ]
  doc.nodes = { [rect.id]: rect, [ellipse.id]: ellipse }
  doc.pages[0].children = [rect.id, ellipse.id]
  return { doc, rectId: rect.id, ellipseId: ellipse.id, pageId: doc.pages[0].id }
}

test('the issue fixture plans four preset tasks and does not change the document', () => {
  const { doc, rectId, ellipseId, pageId } = issueFixture()
  const orphan = node('rectangle', 0, 0, 8, 8)
  orphan.exportSettings = [{ id: 'orphan', format: 'png', scale: 1, suffix: '@gone' }]
  doc.nodes[orphan.id] = orphan
  const before = JSON.stringify(doc)
  const plan = planAllAssets(doc, { scope: 'page', pageId, revision: 7 })
  expect(JSON.stringify(doc)).toBe(before)
  expect(plan).toMatchObject({ documentId: doc.id, revision: 7, scope: 'page', pageId })
  expect(plan.tasks.map(task => [task.nodeId, task.settingId, task.format, task.scale, task.suffix, task.path, task.revision, task.executable])).toEqual([
    [rectId, 'rect-png', 'png', 1, '@one', '矩形@one.png', 7, true],
    [rectId, 'rect-svg', 'svg', 1, '@vector', '矩形@vector.svg', 7, true],
    [ellipseId, 'ell-png', 'png', 1, '@one', '椭圆@one.png', 7, true],
    [ellipseId, 'ell-svg', 'svg', 1, '@vector', '椭圆@vector.svg', 7, true],
  ])
  expect(plan.tasks.every(task => task.pageId === pageId && task.documentId === doc.id && task.pixelCount >= 0)).toBe(true)
  expect(plan.tasks.filter(task => task.format === 'png').every(task => task.pixelCount > 0)).toBe(true)
  expect(plan.tasks.filter(task => task.format === 'svg').every(task => task.pixelCount === 0)).toBe(true)
  expect(plan.tasks.some(task => task.nodeId === orphan.id)).toBe(false)
})

test('document scope includes another page and hidden or round-trip presets stay listed but not executable', () => {
  const { doc, pageId } = issueFixture()
  const hidden = node('rectangle', 4, 4, 12, 12)
  hidden.name = 'Hidden'
  hidden.visible = false
  hidden.exportSettings = [{ id: 'hidden-png', format: 'png', scale: 2, suffix: '@two' }]
  const child = node('ellipse', 0, 0, 6, 6)
  child.exportSettings = [{ id: 'child-png', format: 'png', scale: 1, suffix: '' }]
  hidden.children = [child.id]
  const roundTrip = node('rectangle', 20, 20, 10, 10)
  roundTrip.name = 'Round'
  roundTrip.exportSettings = [
    { id: 'eps', format: 'eps', scale: 1, suffix: '' },
    { id: 'zero', format: 'png', scale: 0, suffix: '@zero' },
  ]
  const slice = node('slice', 0, 0, 15, 9)
  slice.name = '切片'
  slice.exportSettings = [{ id: 'slice-png', format: 'png', scale: 2, suffix: '@two' }]
  const other = node('rectangle', 0, 0, 11, 13)
  other.name = 'Other page'
  other.exportSettings = [{ id: 'other-svg', format: 'svg', scale: 1, suffix: '@vector' }]
  const second = { id: uid(), name: '页面 2', children: [other.id], background: '#ffffff' }
  Object.assign(doc.nodes, { [hidden.id]: hidden, [child.id]: child, [roundTrip.id]: roundTrip, [slice.id]: slice, [other.id]: other })
  doc.pages[0].children.push(hidden.id, roundTrip.id, slice.id)
  doc.pages.push(second)
  const page = planAllAssets(doc, { scope: 'page', pageId, revision: 1 })
  expect(page.tasks.some(task => task.nodeId === other.id)).toBe(false)
  const hiddenTask = page.tasks.find(task => task.settingId === 'hidden-png')
  const childTask = page.tasks.find(task => task.settingId === 'child-png')
  expect(hiddenTask).toMatchObject({ hidden: true, executable: false, blockReason: ALL_ASSETS_HIDDEN_REASON, path: 'Hidden@two.png' })
  expect(childTask).toMatchObject({ hidden: true, executable: false, blockReason: ALL_ASSETS_HIDDEN_REASON })
  expect(page.tasks.filter(task => task.nodeId === roundTrip.id).every(task => !task.executable && task.blockReason === ALL_ASSETS_ROUND_TRIP_REASON)).toBe(true)
  expect(page.tasks.find(task => task.settingId === 'slice-png')).toMatchObject({ executable: true, path: '切片@two.png', pixelCount: 15 * 2 * 9 * 2 })
  const whole = planAllAssets(doc, { scope: 'document', pageId, revision: 1 })
  expect(whole.tasks.find(task => task.settingId === 'other-svg')).toMatchObject({ pageId: second.id, pageName: '页面 2', path: 'Other page@vector.svg', executable: true })
  expect(allAssetPath('图标', { format: 'jpg', scale: 1, suffix: '' })).toBe('图标.jpg')
  expect(allAssetPath('图标', { format: 'png', scale: 2, suffix: '' })).toBe('图标@2x.png')
  expect(allAssetPath('a/b', { format: 'pdf-vector', scale: 1, suffix: '' })).toBe('a_b.pdf')
})

test('All Assets keeps the Sketch shortcut and the shared file-menu label', () => {
  const base = { key: 'e', shiftKey: true, altKey: false, repeat: false, isComposing: false, metaKey: false, ctrlKey: false }
  expect(matchesAllAssetsShortcut({ ...base, metaKey: true }, 'mac')).toBe(true)
  expect(matchesAllAssetsShortcut({ ...base, ctrlKey: true }, 'windows')).toBe(true)
  expect(matchesAllAssetsShortcut({ ...base, ctrlKey: true }, 'linux')).toBe(true)
  expect(matchesAllAssetsShortcut(base, 'mac')).toBe(false)
  expect(matchesAllAssetsShortcut({ ...base, metaKey: true, shiftKey: false }, 'mac')).toBe(false)
  expect(matchesAllAssetsShortcut({ ...base, metaKey: true, ctrlKey: true }, 'mac')).toBe(false)
  expect(fileMenuText['zh-CN'].exportAllAssets).toBe('导出全部资产…')
  expect(fileMenuText.en.exportAllAssets).toBe('Export All Assets…')
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(app).toContain("openExportPanel('assets')")
  expect(app).toContain('matchesAllAssetsShortcut')
  expect(app).toContain("initialTarget={exportEntry === 'assets' ? 'assets' : undefined}")
})
