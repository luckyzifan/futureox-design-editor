// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { PageList } from '../PageList'
import { AGENT_TARGET_EVENT } from './target-event'

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

test('the page AI control appears on hover and targets that page', async () => {
  const editor = new Editor(blank('页面'))
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const seen: Array<{ pageId?: string; prompt?: string }> = []
  const onTarget = (event: Event) => seen.push((event as CustomEvent).detail)
  window.addEventListener(AGENT_TARGET_EVENT, onTarget)
  await act(async () => { root!.render(<PageList editor={editor} onRename={() => {}} />) })
  expect(document.querySelector('.page-ai')).toBeNull()
  const row = document.querySelector<HTMLElement>('.page-row')!
  await act(async () => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  const button = document.querySelector<HTMLButtonElement>('.page-ai')
  expect(button).not.toBeNull()
  await act(async () => { button!.click() })
  const dialog = document.querySelector<HTMLFormElement>('[aria-label^="定向修改"]')
  expect(dialog).not.toBeNull()
  const field = dialog!.querySelector('textarea')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setValue.call(field, '把标题改成秋日特惠'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { dialog!.requestSubmit() })
  expect(seen[0]?.prompt).toContain('秋日特惠')
  expect(seen[0]?.pageId).toBe(editor.state.page)
  window.removeEventListener(AGENT_TARGET_EVENT, onTarget)
  editor.dispose()
})
