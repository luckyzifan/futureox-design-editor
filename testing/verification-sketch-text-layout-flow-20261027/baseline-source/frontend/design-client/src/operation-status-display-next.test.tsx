import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
// Execute the actual footer message expression, not a copied routing decision.
// This baseline fails on visible Chinese output, not missing a new API.
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const footer = app.slice(app.indexOf('      <footer>'), app.indexOf('      </footer>'))
const expression = footer.includes('{operationStatusText(s.message, s.messagePresentation, locale)}')
  ? 'operationStatusText(s.message, s.messagePresentation, locale)' : 's.message'
async function display(editor: Editor, locale: 'zh-CN' | 'en') {
  let resolver: unknown
  if (expression !== 's.message') resolver = (await import(/* @vite-ignore */ './' + 'operation-status-messages')).operationStatusText
  const text = new Function('s', 'locale', 'operationStatusText', `return ${expression}`)(editor.state, locale, resolver)
  return renderToStaticMarkup(<footer><span>{text}</span></footer>)
}
test('existing footer switches an already visible property-copy status without mutating raw message or document', async () => {
  const editor = new Editor(blank()), doc = editor.state.doc, version = editor.state.version
  try {
    ;(editor.notify as any)('已复制属性', { key: 'propertiesCopied' })
    expect(await display(editor, 'zh-CN')).toContain('已复制属性')
    expect(await display(editor, 'en')).toContain('Properties copied')
    expect(await display(editor, 'zh-CN')).toContain('已复制属性')
    expect(editor.state.message).toBe('已复制属性'); expect(editor.state.doc).toBe(doc); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})
test('existing footer translates failure wrapper while preserving and escaping raw diagnostic payload', async () => {
  const editor = new Editor(blank()), error = '<img src=x>文件：已复制属性 & unexpected'
  try {
    ;(editor.notify as any)(`保存失败，当前画布已保留：${error}`, { key: 'saveFailedCanvasRetained', error })
    const html = await display(editor, 'en')
    expect(html).toContain('Save failed; the current canvas was retained: ')
    expect(html).toContain('&lt;img src=x&gt;文件：已复制属性 &amp; unexpected')
    expect(editor.state.message).toBe(`保存失败，当前画布已保留：${error}`)
  } finally { editor.dispose() }
})
