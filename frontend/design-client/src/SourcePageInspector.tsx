import { useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import type { SourceWorkspace } from './LargeDocumentWorkspace'
import { displayColorHex } from './color'
import { usePropertyText } from './property-interface-messages'

/** Page chrome for a source overview. A blank document inspector is not a substitute for the page, canvas and picture sections. */
export function SourcePageInspector({ source, editor }: { source: SourceWorkspace; editor: Editor }) {
  const { tr } = usePropertyText()
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const view = useSyncExternalStore(editor.subscribeCamera, () => editor.effectiveView())
  const zoom = view.zoom
  const page = s.doc.pages.find(item => item.id === s.page)
  const pages = source.openingPreview?.pages
  const current = source.openingPage ? pages?.find(item => item[0] === source.openingPage) : undefined
  const pageName = current?.[1] || (source.openingPage ? source.openingPage : tr('全部页面'))
  const materialCount = source.openingPreview?.items.length ?? source.nativeCanvas?.snapshot.roots
  const status=source.nativeCanvas?.status,shown=status?.view
  const sharp = !source.hideNative&&status?.phase==='ready'&&status.sharp===true&&
    !!shown&&shown.x===view.x&&shown.y===view.y&&shown.zoom===view.zoom
  const background = page ? displayColorHex(page.background) || page.background : ''
  return <aside className="inspector source-page-inspector">
    <div className="panel-tabs"><b>{tr('设计')}</b><span>{tr('属性')}</span></div>
    <section>
      <h3>{tr('页面')}</h3>
      <dl>
        <dt>{tr('当前页面')}</dt><dd>{pageName}</dd>
        <dt>{tr('素材数量')}</dt><dd>{materialCount ?? '—'}</dd>
        <dt>{tr('页面数量')}</dt><dd>{pages?.length ?? '—'}</dd>
      </dl>
    </section>
    <section>
      <h3>{tr('画布')}</h3>
      <dl>
        <dt>{tr('视图缩放')}</dt><dd>{Math.round(zoom * 100)}%</dd>
        {background && <><dt>{tr('预览底色')}</dt><dd><i className="source-preview-swatch" style={{ background }} />{background}</dd></>}
      </dl>
      <label className="check-row"><input type="checkbox" checked={s.grid} onChange={event => editor.set({ grid: event.target.checked })} />{tr('显示网格')}</label>
      <label className="check-row"><input type="checkbox" checked={s.snap} onChange={event => editor.set({ snap: event.target.checked })} />{tr('智能吸附')}</label>
    </section>
    <section>
      <h3>{tr('画面')}</h3>
      <p className="source-picture-state" data-sharp={sharp ? 'true' : 'false'}>{sharp ? tr('清晰') : tr('低分辨率预览')}</p>
      <p>{tr('双击左侧素材进入原始图层。精修完整画板后，画面换成清晰的原始像素。')}</p>
    </section>
  </aside>
}
