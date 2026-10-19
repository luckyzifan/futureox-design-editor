import { useRef, useState } from 'react'
import type { Editor } from './engine'
import { DraftInput } from './DraftInput'
import { scaleInputFactor, selectionScaleFrame } from './selection-scale'
import { lockedSelectionIds } from './canvas-menu-model'

const anchors = ['左上', '上中', '右上', '左中', '中心', '右中', '左下', '下中', '右下']
export function ScaleInspector({ editor }: { editor: Editor }) {
  const [anchor, setAnchor] = useState(4), s = editor.state, ids = editor.topSelection()
  const accepted = useRef(true)
  const frame = selectionScaleFrame(s.doc, s.page, ids)
  const disabled = s.busy || !!lockedSelectionIds(editor).length || !ids.length || editor.interactionActive
  const exit = () => { editor.set({ tool: 'select' }); document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true }) }
  const valid = (value: string, original?: number) => {
    try { scaleInputFactor(value, original); return true } catch { return false }
  }
  const commit = (q: number) => {
    accepted.current = !disabled && editor.scaleSelection(q, anchor)
    if (!accepted.current) return
    // Let DraftInput finish clearing its dirty flag before focus triggers blur.
    const generation = editor.sessionGeneration
    queueMicrotask(() => { if (generation === editor.sessionGeneration && editor.state.tool === 'scale') exit() })
  }
  return <aside className="inspector scale-inspector" aria-label="等比缩放属性">
    <section onInputCapture={() => { accepted.current = true }} onKeyDown={e => {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Escape' || (e.key === 'Enter' && accepted.current && e.target instanceof HTMLInputElement && e.target.checkValidity())) { e.stopPropagation(); exit() }
    }}>
      <h3>缩放 <button type="button" aria-label="关闭缩放工具" onClick={exit}>×</button></h3>
      {!ids.length ? <p>选择要缩放的图层</p> : <>
        <div className="field-grid">
          <label>宽度<DraftInput aria-label="缩放宽度" disabled={disabled || frame.width === 0} value={String(frame.width)} validate={v => valid(v, frame.width)} onCommit={v => commit(scaleInputFactor(v, frame.width))} /></label>
          <label>高度<DraftInput aria-label="缩放高度" disabled={disabled || frame.height === 0} value={String(frame.height)} validate={v => valid(v, frame.height)} onCommit={v => commit(scaleInputFactor(v, frame.height))} /></label>
          <label>倍率<DraftInput data-tool-autofocus="true" autoFocus onFocus={e => e.currentTarget.select()} aria-label="缩放倍率" disabled={disabled} value="1x" validate={v => valid(v)} onCommit={v => commit(scaleInputFactor(v))} /></label>
          <div className="scale-anchor" role="radiogroup" aria-label="缩放锚点" onKeyDown={e => {
            const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 } as Record<string, number>)[e.key]
            if (offset === undefined) return
            e.preventDefault(); e.stopPropagation()
            const next = (anchor + offset + 9) % 9; setAnchor(next)
            e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
          }}>{anchors.map((name, index) => <button type="button" role="radio" tabIndex={anchor === index ? 0 : -1} aria-label={name} aria-checked={anchor === index} disabled={disabled} key={name} onClick={() => setAnchor(index)}>{anchor === index ? '■' : '·'}</button>)}</div>
        </div>
      </>}
    </section>
  </aside>
}
