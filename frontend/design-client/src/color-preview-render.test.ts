// Actual Rust CPU raster evidence only. This does not exercise browser Canvas,
// compositor/GPU presentation, pointer latency, or a real presentation callback.
import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { ColorEditSession } from './color-edit-session'
import { defaultColorSettings } from './color'
function raster(document: DesignDocument) {
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(document))
    const bytes = kernel.render_rgba(JSON.stringify({ pageId: document.pages[0].id, width: 32, height: 32,
      view: { x: 0, y: 0, zoom: 1 }, rasterProfile: 'figma', grid: false, transparent: false }))
    return { hash: createHash('sha256').update(bytes).digest('hex'), pixel: Array.from(bytes.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)) }
  } finally { kernel.free() }
}
test.each([false, true])('real CPU pixels distinguish owned preview from authored snapshot and match final commit; managed=%s', managed => {
  const document = blank(), shape = node('rectangle', 0, 0, 32, 32)
  document.rasterProfile = 'figma'; document.pages[0].background = '#ffffff'; document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
  shape.fills[0].color = managed ? 'color(srgb-linear 4 .03 .02 / .7)' : '#ff0000'; shape.opacity = .8
  if (managed) { document.schemaVersion = 3; document.colorManagement = defaultColorSettings() }
  const editor = new Editor(document)
  try {
    editor.select([shape.id]); const before = raster(editor.authoredDocument)
    const target = { kind: 'solid-fill' as const, nodeId: shape.id, fillId: shape.fills[0].id, fillIndex: 0 }
    const session = ColorEditSession.open(editor, target)!
    session.update({ color: managed ? 'color(display-p3 .02 1 .04 / .5)' : '#0000ff', opacity: '40' })
    const preview = raster(editor.state.doc), authoredWhilePreview = raster(editor.authoredDocument)
    expect(preview.hash).not.toBe(before.hash); expect(authoredWhilePreview).toEqual(before); expect(editor.state.version).toBe(0)
    expect(session.commit()).toBe(true); const committed = raster(editor.authoredDocument)
    expect(committed).toEqual(preview); expect(editor.state.version).toBe(1)
    editor.undo(); const undone = raster(editor.authoredDocument); expect(undone).toEqual(before)
    const cancelled = ColorEditSession.open(editor, target)!; cancelled.update({ opacity: '10' }); cancelled.cancel()
    expect(raster(editor.authoredDocument)).toEqual(before)
    const output = process.env.COLOR_PREVIEW_RENDER_EVIDENCE
    if (output) writeFileSync(`${output}/cpu-${managed ? 'managed' : 'sdr'}.json`, JSON.stringify({
      backend: 'actual Rust VectorEngine.render_rgba', browserPresentationVerified: false,
      before, preview, authoredWhilePreview, committed, undone,
    }, null, 2) + '\n')
  } finally { editor.dispose() }
})
