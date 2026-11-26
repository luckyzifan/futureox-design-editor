// Real React/jsdom and Editor; no Canvas, native window or GPU claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SketchInteractionPanel } from './SketchInteractionPanel'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'

let dom: JSDOM, root: Root, mount: HTMLElement, editor: Editor
let rectangle: ReturnType<typeof node>, frame: ReturnType<typeof node>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'HTMLInputElement', 'Node', 'Event', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset()
  interfacePreference.set({ uiMode: 'sketch', locale: 'zh-CN' })
  const doc = blank('Interaction inspector')
  frame = node('frame', 0, 0, 320, 640); frame.name = '目标画框'
  rectangle = node('rectangle', 20, 30, 80, 40); rectangle.name = '按钮'
  doc.nodes[frame.id] = frame; doc.nodes[rectangle.id] = rectangle
  doc.pages[0].children = [frame.id, rectangle.id]
  editor = new Editor(doc)
  editor.select([rectangle.id])
  mount = document.createElement('div'); document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose(); interfacePreference.reset(); dom.window.close(); vi.unstubAllGlobals()
})

async function render() {
  await act(async () => {
    root.render(<SketchInteractionPanel editor={editor} doc={editor.state.doc} selection={editor.state.selection} armed={false} />)
  })
}
async function setSelect(label: string, value: string) {
  const control = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}
async function setNumber(label: string, value: string) {
  const control = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

test('ordinary Sketch layers expose Target, Trigger, Animation, Duration and Easing on the existing prototype model', async () => {
  await render()
  const section = document.querySelector('.sketch-interaction-panel')!
  expect(section.textContent).toContain('交互')
  for (const label of ['链接到', '触发方式', '动画类型', '时长（毫秒）', '缓动']) expect(section.querySelector(`[aria-label="${label}"]`), label).not.toBeNull()
  const target = document.querySelector<HTMLSelectElement>('[aria-label="链接到"]')!
  expect(target.value).toBe('')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="触发方式"]')!.disabled).toBe(true)

  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(target, frame.id)
    target.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(editor.state.doc.prototype?.interactions[rectangle.id]).toEqual([{ trigger: 'click', actions: [{ kind: 'navigate', target: frame.id, transitionStyle: 'none' }] }])

  await render()
  await setSelect('触发方式', 'hover')
  await render()
  expect(editor.state.doc.prototype?.interactions[rectangle.id][0].trigger).toBe('hover')
  await setSelect('动画类型', 'dissolve')
  await render()
  await setNumber('时长（毫秒）', '450')
  await setSelect('缓动', 'linear')
  expect(editor.state.doc.prototype?.interactions[rectangle.id][0].actions[0]).toMatchObject({
    kind: 'navigate', target: frame.id, transitionStyle: 'dissolve', durationMs: 450, easingCurve: 'linear',
  })

  await render()
  await setSelect('链接到', '')
  expect(editor.state.doc.prototype?.interactions[rectangle.id]).toBeUndefined()
})

test('hotspot Link to and the no-selection hint keep their existing behavior', async () => {
  await render()
  await setSelect('链接到', frame.id)
  expect(editor.state.doc.prototype?.interactions[rectangle.id][0].actions[0]).toMatchObject({ kind: 'navigate', target: frame.id })
  const version = editor.state.version
  await act(async () => {
    editor.select([])
    root.render(<SketchInteractionPanel editor={editor} doc={editor.state.doc} selection={editor.state.selection} armed={true} />)
  })
  expect(document.querySelector('.sketch-interaction-panel')?.textContent).toContain('在画布上拖动以绘制热点')
  expect(editor.state.version).toBe(version)
  await act(async () => {
    root.render(<SketchInteractionPanel editor={editor} doc={editor.state.doc} selection={editor.state.selection} armed={false} />)
  })
  expect(document.querySelector('.sketch-interaction-panel')).toBeNull()
})