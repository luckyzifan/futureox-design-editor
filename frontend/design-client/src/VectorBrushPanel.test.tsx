// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { pathNetwork } from './path-network'
import { defaultVectorBrush } from './vector-brush'
import { VectorBrushPanel } from './VectorBrushPanel'
test('shared brush inspector exposes actual source, deterministic parameters and reversible bake', () => {
  const d=blank(), target=node('vector',0,0,40,20), source=node('vector',0,0,4,2)
  target.network=pathNetwork('M0 0L40 0');target.fills=[paint()]
  source.network=pathNetwork('M0 0L4 0L4 2L0 2Z');source.fills=[paint()];source.name='Brush source'
  target.vectorBrush=defaultVectorBrush(source.network)
  d.nodes[target.id]=target;d.nodes[source.id]=source;d.pages[0].children=[target.id,source.id]
  const editor=new Editor(d)
  try {
    const html=renderToStaticMarkup(<VectorBrushPanel editor={editor} node={editor.state.doc.nodes[target.id]}/>)
    for(const label of ['Brush source','随机种子','散布间距','跟随路径方向','笔刷源网络 JSON','展开为可编辑轮廓','曲线 Stretch 暂不支持']) expect(html).toContain(label)
  } finally { editor.dispose() }
})
test('an unbrushed selection builds the vector source list when its disclosure opens', async () => {
  const doc = blank(), target = node('vector'), source = node('vector')
  for (const n of [target, source]) {
    n.network = pathNetwork('M0 0L4 0L4 4Z'); n.fills = [paint()]
    doc.nodes[n.id] = n; doc.pages[0].children.push(n.id)
  }
  const editor = new Editor(doc), container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<VectorBrushPanel editor={editor} node={editor.state.doc.nodes[target.id]}/>))
    const details = container.querySelector('details')!
    expect(container.querySelector(`option[value="${source.id}"]`)).toBeNull()
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
    expect(container.querySelector(`option[value="${source.id}"]`)).not.toBeNull()
  } finally { await act(async () => root.unmount()); editor.dispose() }
})
