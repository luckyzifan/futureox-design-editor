import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { canvasStatusLabel } from './canvas-status-label'
import { operationStatusText } from './operation-status-messages'
import { translateProfessional } from './professional-dialog-messages'
function display(editor: Editor, locale: 'zh-CN' | 'en') {
  const { message, messagePresentation } = editor.state
  const text = translateProfessional(canvasStatusLabel(operationStatusText(message, messagePresentation, locale)), locale)
  return renderToStaticMarkup(<footer><span>{text}</span></footer>)
}
test('existing footer switches an already visible property-copy status without mutating raw message or document', () => {
  const editor = new Editor(blank()), doc = editor.state.doc, version = editor.state.version
  try {
    editor.notify('已复制属性', { key: 'propertiesCopied' })
    expect(display(editor, 'zh-CN')).toContain('已复制属性')
    expect(display(editor, 'en')).toContain('Properties copied')
    expect(display(editor, 'zh-CN')).toContain('已复制属性')
    expect(editor.state.message).toBe('已复制属性'); expect(editor.state.doc).toBe(doc); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})
test('existing footer translates failure wrapper while preserving and escaping raw diagnostic payload', () => {
  const editor = new Editor(blank()), error = '<img src=x>文件：已复制属性 & unexpected'
  try {
    editor.notify(`保存失败，当前画布已保留：${error}`, { key: 'saveFailedCanvasRetained', error })
    const html = display(editor, 'en')
    expect(html).toContain('Save failed; the current canvas was retained: ')
    expect(html).toContain('&lt;img src=x&gt;文件：已复制属性 &amp; unexpected')
    expect(editor.state.message).toBe(`保存失败，当前画布已保留：${error}`)
  } finally { editor.dispose() }
})
