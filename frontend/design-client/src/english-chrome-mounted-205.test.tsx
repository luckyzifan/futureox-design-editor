// Mounted product chrome for the remaining English-locale strings in issue #205.
// jsdom + Editor/WASM. Not an Electron, macOS, or window-geometry result.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AnimationPanel } from './AnimationPanel'
import { ImportNotice } from './ImportNotice'
import { LocalDiagnosticsPanel } from './LocalDiagnosticsPanel'
import { ReviewsPanel } from './ReviewsPanel'
import { StrokeProfilePanel } from './StrokeProfilePanel'
import { VectorBrushPanel } from './VectorBrushPanel'
import { Editor } from './engine'
import { interfacePreference, type UiMode } from './interface-preference'
import { blank, node, paint, stroke } from './model'
import { pathNetwork } from './path-network'
import { defaultVectorBrush } from './vector-brush'

const han = /\p{Script=Han}/u
let dom: JSDOM, root: Root, editor: Editor | undefined

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  interfacePreference.reset()
  const mount = document.createElement('div')
  document.body.append(mount)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor?.dispose()
  editor = undefined
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
})

function vectorDocument() {
  const doc = blank('未命名设计')
  doc.pages[0].name = '页面 1'
  const target = node('vector', 0, 0, 40, 20)
  target.name = 'Frame A'
  target.network = pathNetwork('M0 0L40 0')
  target.fills = [paint()]
  target.strokes = [stroke('#111111', 2)]
  const source = node('vector', 0, 0, 4, 2)
  source.name = '作者设计'
  source.network = pathNetwork('M0 0L4 0L4 2L0 2Z')
  source.fills = [paint()]
  target.vectorBrush = defaultVectorBrush(source.network!)
  doc.nodes[target.id] = target
  doc.nodes[source.id] = source
  doc.pages[0].children = [target.id, source.id]
  return { doc, id: target.id }
}

test('English comments, brush, stroke, animation and import chrome have no product Chinese', async () => {
  const fixture = vectorDocument()
  editor = new Editor(fixture.doc)
  const shape = editor.state.doc.nodes[fixture.id]
  for (const uiMode of ['figma', 'sketch'] as const) {
    await act(async () => {
      interfacePreference.set({ locale: 'en', uiMode })
      root.render(<>
        <ReviewsPanel editor={editor!} />
        <VectorBrushPanel editor={editor!} node={shape} />
        <StrokeProfilePanel editor={editor!} n={shape} index={0} update={() => {}} />
        <AnimationPanel editor={editor!} onClose={() => {}} />
        <ImportNotice warnings={['fonts without embedded resources']} onClose={() => {}} />
        <LocalDiagnosticsPanel />
      </>)
    })
    const text = document.body.textContent ?? ''
    expect(document.querySelector('.local-reviews')?.getAttribute('aria-label'), uiMode).toBe('Local comments and annotations')
    expect(text, uiMode).toContain('Click the canvas to place a comment')
    expect(text, uiMode).toContain('Vector brush')
    expect(text, uiMode).toContain('Brush width')
    expect(text, uiMode).toContain('Width profile')
    expect(text, uiMode).toContain('Animation')
    expect(text, uiMode).toContain('Imported. You can keep editing')
    expect(text, uiMode).toContain('Local error log')
    expect(text, uiMode).toContain('作者设计')
    const withoutAuthored = text.replaceAll('作者设计', '')
    expect(withoutAuthored, uiMode).not.toMatch(han)
    expect(editor.state.doc.nodes[fixture.id].name).toBe('Frame A')
    expect(editor.state.doc.name).toBe('未命名设计')
  }
})
