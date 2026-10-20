import { expect, test } from 'vitest'
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
