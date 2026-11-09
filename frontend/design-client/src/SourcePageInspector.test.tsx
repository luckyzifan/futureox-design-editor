// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { SourcePageInspector } from './SourcePageInspector'
import type { SourceWorkspace } from './LargeDocumentWorkspace'

let root: Root | undefined
let editor: Editor | undefined
afterEach(() => { root?.unmount(); editor?.dispose(); vi.unstubAllGlobals() })

test('a source overview inspector is a page, canvas and picture sheet', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://design.invalid' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'localStorage'] as const)
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  editor = new Editor(blank())
  const source = {
    hideNative: true,
    openingPage: 'p',
    openingPreview: { pages: [['p', '浅色', 2]], items: [{ name: '140x140pt 30个（黑色）' }, { name: '44x44pt 30个（白色）' }] },
  } as unknown as SourceWorkspace
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root!.render(<SourcePageInspector source={source} editor={editor!} />) })
  const text = document.body.textContent || ''
  expect(text).toContain('页面')
  expect(text).toContain('浅色')
  expect(text).toContain('画布')
  expect(text).toContain('画面')
  expect(text).toContain('低分辨率预览')
  expect(text).toContain('2')
  expect(text).not.toContain('选中图层后，在这里编辑颜色、形状与约束。')
  const status = { phase: 'ready' as const, done: 1, total: 1, sharp: true, view: { ...editor.effectiveView() } }
  const current = { ...source, hideNative: false, nativeCanvas: { status } } as unknown as SourceWorkspace
  const draw = (next: SourceWorkspace) => act(async () => { root!.render(<SourcePageInspector source={next} editor={editor!} />) })
  await draw(current)
  expect(document.querySelector('.source-picture-state')?.getAttribute('data-sharp')).toBe('true')
  for (const changed of [{ ...status, phase: 'refining' }, { ...status, sharp: false }, { ...status, view: { ...status.view, zoom: status.view.zoom * 2 } }]) {
    await draw({ ...current, nativeCanvas: { status: changed } } as unknown as SourceWorkspace)
    expect(document.querySelector('.source-picture-state')?.getAttribute('data-sharp')).toBe('false')
  }
  await draw(current)
  await act(async () => { editor!.set({ view: { ...status.view, x: status.view.x + 20 } }) })
  expect(document.querySelector('.source-picture-state')?.getAttribute('data-sharp')).toBe('false')
  await act(async () => { root!.unmount() })
  root = undefined
  dom.window.close()
})
