// Headless React/DOM events plus real WASM; no GPU, GUI, server or sockets.
// @ts-expect-error jsdom is a test-only dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { gunzipSync } from 'fflate'
import { Editor } from './engine'
import { blank, node } from './model'
import { ExportPanel } from './ExportPanel'

test('UI SVG controls generate real bounded SVGZ with selected precision and scale', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://design.invalid' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const doc = blank(), shape = node('text', 0, 0, 100.12345, 80.12345)
  doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const editor = new Editor(doc); editor.select([shape.id])
  const blobs: Blob[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const root = createRoot(document.getElementById('root')!)
  try {
    await act(async () => root.render(<ExportPanel editor={editor} onClose={() => {}} />))
    async function select(label: string, value: string) { await act(async () => { const input = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
    await select('导出图像格式', 'svg'); await select('SVG 坐标精度', '2'); await select('SVG 压缩', 'gzip'); await select('SVG 文字模式', 'editable')
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '生成 SVG')!.click())
    await act(async () => { await vi.waitFor(() => expect(blobs).toHaveLength(1)) })
    expect(blobs, document.querySelector('[role="status"]')?.textContent ?? '').toHaveLength(1)
    const content = new TextDecoder().decode(gunzipSync(new Uint8Array(await blobs[0].arrayBuffer())))
    expect(content).toContain('<text ')
    expect(content).toContain('data-editable-text="1"')
    expect(content).toContain('width="100.12"')
    expect(document.querySelector('a')?.download).toMatch(/\.svgz$/)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('有损舍入')
  } finally { await act(async () => root.unmount()); editor.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close() }
})
