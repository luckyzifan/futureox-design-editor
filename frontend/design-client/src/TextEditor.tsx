import { ActionSource } from './canvas-action-diagnostics'
import { createInputDiagnostics, InputFamily, InputPhase } from './input-diagnostics'
import {apply,matrixString} from './geometry'
import { propertyUnits } from './property-units'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesignDocument, DesignNode, Matrix } from './model'
import { replaceText, styleTextRange } from './text'
import { kernelTextLayout } from './kernel/picking'
import type { Editor } from './engine'
import { registerPendingEdit, pendingEditsChanged } from './pending-edits'
import { useProfessionalDialogText } from './professional-dialog-messages'
import { sourceFonts, storeRemappedSourceFonts, type FontSourceRecord } from './font-matching'
import { equalValue } from './document-patch'

export function TextInput({
  node,
  editor,
  onClose,
  canvas = false,
  style,
}: {
  node: DesignNode
  editor: Editor
  onClose?: () => void
  canvas?: boolean
  style?: React.CSSProperties
}) {
  const { tr } = useProfessionalDialogText()
  const diagnostic = useMemo(() => createInputDiagnostics(editor, InputFamily.text, canvas ? ActionSource.keyboard : ActionSource.properties), [editor, canvas])
  useEffect(() => () => diagnostic.dispose(), [diagnostic])
  const input = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false),
    blurred = useRef(false),
    done = useRef(false)
  const session = useRef(editor.sessionGeneration)
  const original = useRef(node.text),
    value = useRef(node.text)
  const finish = (cancel = false) => {
    if (done.current) return true
    if (composing.current) return false
    done.current = true
    const changed = value.current !== original.current
    if (!cancel && value.current !== original.current) {
      diagnostic.start()
      if (editor.sessionGeneration !== session.current || editor.state.doc.nodes[node.id]?.text !== original.current) {
        done.current = false
        diagnostic.valid(false)
        editor.notify('文字已被其他操作修改；输入仍保留在编辑框，请复制或按 Esc 取消')
        return false
      }
      const replace = (n: DesignNode, doc: DesignDocument) => {
        const source = replaceText(n, value.current, sourceFonts(doc, n))
        storeRemappedSourceFonts(doc, n.id, source)
      }
      if (canvas) editor.update([node.id], replace, '编辑文字')
      else editor.updateProperties([node.id], replace, '编辑文字')
      if (editor.state.doc.nodes[node.id]?.text !== value.current) {
        done.current = false
        diagnostic.finish(false, false)
        return false
      }
    }
    if (cancel) diagnostic.cancel(); else diagnostic.finish(changed, true)
    original.current = value.current
    pendingEditsChanged(editor)
    onClose?.()
    return true
  }
  const commit = useRef(finish)
  commit.current = finish
  useEffect(() => registerPendingEdit(editor, {
    dirty: () => composing.current || value.current !== original.current,
    commit: () => commit.current(),
  }), [editor, node.id])
  useEffect(() => {
    if (!composing.current && value.current === original.current) {
      original.current = node.text
      value.current = node.text
      if (input.current) input.current.value = node.text
    }
  }, [node.text])
  useEffect(() => {
    if (canvas) {
      input.current?.focus()
      input.current?.select()
    }
  }, [canvas])
  return (
    <textarea
      ref={input}
      aria-label={tr(canvas ? '画布文字编辑' : '文字内容')}
      className={canvas ? 'canvas-text-input' : undefined}
      defaultValue={node.text}
      spellCheck={false}
      dir="auto"
      style={style}
      onFocus={() => {
        diagnostic.event(InputPhase.focus)
        done.current = false
        blurred.current = false
      }}
      onChange={(e) => {
        diagnostic.start()
        value.current = e.currentTarget.value
        done.current = false
        pendingEditsChanged(editor)
      }}
      onCompositionStart={() => {
        diagnostic.start(); diagnostic.event(InputPhase.compositionStart)
        done.current = false
        composing.current = true
        pendingEditsChanged(editor)
      }}
      onCompositionEnd={(e) => {
        diagnostic.event(InputPhase.compositionEnd)
        composing.current = false
        value.current = e.currentTarget.value
        pendingEditsChanged(editor)
        if (blurred.current) finish()
      }}
      onBlur={() => {
        diagnostic.event(InputPhase.blur)
        blurred.current = true
        finish()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || composing.current) return
        if (e.key === 'Escape') {
          e.preventDefault()
          input.current!.value = original.current
          value.current = original.current
          finish(true)
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          finish()
          input.current?.blur()
        }
      }}
    />
  )
}

export function CanvasTextEditor({
  onPreview,
  document,
  node,
  editor,
  matrix,
  viewport = { width: 1000, height: 800 },
  onClose,
  isCurrent,
}: {
  onPreview: (node:DesignNode|null)=>void
  document: DesignDocument
  node: DesignNode
  editor: Editor
  matrix: Matrix
  viewport?: { width: number; height: number }
  onClose: (restoreCanvasFocus?: boolean) => void
  isCurrent?: () => boolean
}) {
  const { tr } = useProfessionalDialogText()
  const diagnostic = useMemo(() => createInputDiagnostics(editor, InputFamily.richText, ActionSource.keyboard), [editor])
  useEffect(() => () => diagnostic.dispose(), [diagnostic])
  const [draft, setDraft] = useState(() => structuredClone(node)),
    [selection, setSelection] = useState<[number, number]>([0, node.text.length]),
    [error, setError] = useState(''),
    [toolbarSize, setToolbarSize] = useState({ width: 760, height: 44 })
  const input = useRef<HTMLTextAreaElement>(null),
    root = useRef<HTMLDivElement>(null),
    toolbar = useRef<HTMLDivElement>(null),
    composing = useRef(false),
    done = useRef(false),
    original = useRef(node),
    session = useRef(editor.sessionGeneration),
    blurred = useRef(false),
    anchor = useRef<number | null>(null),
    latest = useRef(draft)
  const originalSource = useRef(sourceFonts(document, node))
  const editedSource = useRef<FontSourceRecord | undefined>(undefined)
  const draftChanged = () => latest.current.text !== original.current.text ||
    !equalValue(latest.current.textRuns, original.current.textRuns) ||
    (editedSource.current !== undefined && !equalValue(editedSource.current, originalSource.current))
  latest.current = draft
  useLayoutEffect(() => {
    const element = toolbar.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width && height) setToolbarSize(old => old.width === width && old.height === height ? old : { width, height })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [viewport.width, viewport.height])
  useLayoutEffect(()=>{onPreview(draft);return()=>onPreview(null)},[draft,onPreview])
  let layout: ReturnType<typeof kernelTextLayout> | undefined
  try {
    layout = kernelTextLayout(draft)
  } catch (e) {
    if (!error) queueMicrotask(() => setError(String(e)))
  }
  useEffect(() => {
    if (isCurrent && !isCurrent()) return
    input.current?.focus()
    input.current?.setSelectionRange(0, node.text.length)
  }, [node.id])
  const sync = () => {
    if (input.current) setSelection([input.current.selectionStart, input.current.selectionEnd])
  }
  const select = (a: number, b = a) => {
    input.current?.focus()
    input.current?.setSelectionRange(Math.min(a, b), Math.max(a, b), a > b ? 'backward' : 'forward')
    setSelection([Math.min(a, b), Math.max(a, b)])
  }
  const finish = (cancel = false, restoreCanvasFocus = false) => {
    if (isCurrent && !isCurrent()) return true
    if (done.current) return true
    if (composing.current) return false
    const changed = draftChanged()
    if (!cancel && changed) {
      diagnostic.start()
      if (editor.sessionGeneration !== session.current || editor.state.doc.nodes[node.id] !== original.current) {
        diagnostic.valid(false)
        setError('图层已被修改，当前输入保留；请复制文字后取消')
        return false
      }
      editor.update(
        [node.id],
        (n, doc) => {
          n.text = latest.current.text
          n.textRuns = latest.current.textRuns
          storeRemappedSourceFonts(doc, n.id, editedSource.current)
        },
        '编辑富文本',
      )
      const committed = editor.state.doc.nodes[node.id]
      if (committed?.text !== latest.current.text || !equalValue(committed.textRuns, latest.current.textRuns) ||
          (editedSource.current && !equalValue(sourceFonts(editor.state.doc, committed), editedSource.current))) {
        diagnostic.finish(false, false)
        return false
      }
    }
    if (cancel) diagnostic.cancel(); else diagnostic.finish(changed, true)
    done.current = true
    pendingEditsChanged(editor)
    onClose(restoreCanvasFocus)
    return true
  }
  const commit = useRef(finish)
  commit.current = finish
  useEffect(() => registerPendingEdit(editor, {
    dirty: () => !done.current && (composing.current || draftChanged()),
    commit: () => commit.current(),
  }), [editor, node.id])
  const change = (text: string) => {
    diagnostic.start()
    const n = structuredClone(latest.current)
    const fonts = replaceText(n, text, editedSource.current ?? originalSource.current)
    if (fonts) editedSource.current = fonts
    latest.current = n
    setDraft(n)
    pendingEditsChanged(editor)
    setError('')
    sync()
  }
  const style = (patch: Partial<import('./model').TextRun>) => {
    diagnostic.start(); diagnostic.event(InputPhase.start, { fieldFamily: InputFamily.richStyle })
    try {
      const n = structuredClone(latest.current)
      const fonts = styleTextRange(n, ...selection, patch, editedSource.current ?? originalSource.current)
      if (fonts) editedSource.current = fonts
      latest.current = n
      setDraft(n)
      pendingEditsChanged(editor)
      select(...selection)
    } catch (e) {
      setError(String(e))
    }
  }
  const point = (offset: number) => {
    const l =
      layout?.lines.find((l) => l.start <= offset && offset <= l.end) || layout?.lines.at(-1)
    const g = layout?.glyphs.find((g) => g.cluster === offset),
      previous = layout?.glyphs.find((g) => g.clusterEnd === offset)
    const flat={x:g?.x??(previous?previous.x+previous.advance:0),y:l?.y||0}
    const pose=g?.pathTransform||previous?.pathTransform
    return {...(pose?apply(pose,flat):flat),flat,height:l?.height||draft.fontSize*1.35,pose}

  }
  const hit = (event: React.PointerEvent) => {
    const rect = root.current!.getBoundingClientRect()
    // SVG screen CTM includes all surrounding editor offsets and rotation.
    const svg = root.current!.querySelector('svg')!,
      ctm = svg.getScreenCTM()
    const p = ctm
      ? new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
      : { x: event.clientX - rect.x, y: event.clientY - rect.y }
    const l = layout?.lines.reduce((best, l) =>
      Math.abs(l.y + l.height / 2 - p.y) < Math.abs(best.y + best.height / 2 - p.y) ? l : best,
    )
    const candidates =
      layout?.glyphs.filter((g) => !!draft.textPath || !l || (g.cluster >= l.start && g.cluster < l.end)) || []
    let best = l?.start || 0,
      distance = Infinity
    for (const g of candidates)
      for (const [x, index] of [
        [g.x, g.cluster],
        [g.x + g.advance, g.clusterEnd],
      ])
        {const target=g.pathTransform?apply(g.pathTransform,{x,y:g.y-g.size/2}):{x,y:p.y};const d=Math.hypot(target.x-p.x,target.y-p.y);if(d<distance){distance=d;best=index}}

    return best
  }
  const navigate = (e: React.KeyboardEvent) => {
    if (
      !layout ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)
    )
      return
    e.preventDefault()
    const backward = input.current?.selectionDirection === 'backward',
      focus = backward ? selection[0] : selection[1],
      anchor = backward ? selection[1] : selection[0]
    const boundaries = [
      ...new Set([
        0,
        draft.text.length,
        ...Array.from(
          new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(draft.text),
          (s) => s.index,
        ),
      ]),
    ].sort((a, b) => a - b)
    let next = focus
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!e.shiftKey && selection[0] !== selection[1])
        next = e.key === 'ArrowLeft' ? selection[0] : selection[1]
      else {
        const i = boundaries.indexOf(focus)
        next =
          boundaries[
            Math.max(0, Math.min(boundaries.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))
          ]
      }
    } else {
      const i = Math.max(
          0,
          layout.lines.findIndex((l) => l.start <= focus && focus <= l.end),
        ),
        line =
          layout.lines[
            Math.max(
              0,
              Math.min(
                layout.lines.length - 1,
                i + (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0),
              ),
            )
          ]
      if (e.key === 'Home') next = line.start
      else if (e.key === 'End') next = line.end
      else {
        const x = point(focus).x
        let distance = Infinity
        for (const candidate of boundaries.filter((v) => v >= line.start && v <= line.end)) {
          const d = Math.abs(point(candidate).x - x)
          if (d < distance) {
            distance = d
            next = candidate
          }
        }
      }
    }
    select(e.shiftKey ? anchor : next, next)
  }
  const caret = point(
    input.current?.selectionDirection === 'backward' ? selection[0] : selection[1],
  ),
    fill = draft.fills[0]?.color || '#222222'
  // The run covering the selection start feeds the toolbar defaults; runs
  // without an explicit fontId/weight inherit the node's text style.
  const activeRun = draft.textRuns?.find(
    (r) => r.start <= selection[0] && selection[0] < Math.max(r.end, r.start + 1),
  )
  const runFontId = activeRun?.fontId ?? '',
    runWeight = activeRun?.weight ?? draft.textStyle?.weight ?? 400
  // Matrix maps document coordinates into canvas CSS pixels. Only the anchor
  // uses it: controls remain outside the transformed text surface.
  const selectionPoint = point(selection[0])
  const screenAnchor = apply(matrix, selectionPoint)
  const screenBelow = apply(matrix, { x: selectionPoint.x, y: selectionPoint.y + selectionPoint.height })
  const toolbarWidth = Math.min(toolbarSize.width, Math.max(0, viewport.width - 16))
  const toolbarLeft = Math.max(8, Math.min(viewport.width - toolbarWidth - 8, screenAnchor.x))
  const preferredTop = screenAnchor.y - toolbarSize.height - 8
  const toolbarTop = Math.max(8, Math.min(viewport.height - toolbarSize.height - 8,
    preferredTop >= 8 ? preferredTop : screenBelow.y + 8))
  return (
    <div
      ref={root}
      className="rich-text-editor"
      style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none' }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onFocus={() => { diagnostic.event(InputPhase.focus); blurred.current = false }}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node)) { diagnostic.event(InputPhase.blur); blurred.current = true; finish() }
      }}
    >
      <div
        ref={toolbar}
        className="rich-text-toolbar"
        role="toolbar"
        aria-label={tr('文字格式')}
        style={{ zIndex: 21, left: toolbarLeft, top: toolbarTop, maxWidth: Math.max(0, viewport.width - 16), maxHeight: Math.max(0, viewport.height - 16), pointerEvents: 'auto' }}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) e.preventDefault()
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) e.preventDefault()
        }}
      >
        <button type="button" title={tr('下划线')} onClick={() => style({ underline: true })}>
          U̲
        </button>
        <button type="button" title={tr('删除线')} onClick={() => style({ strikethrough: true })}>
          S̶
        </button>
        <button
          type="button"
          onClick={() =>
            style({ underline: false, strikethrough: false, color: undefined, link: undefined })
          }
        >
          {tr('清除装饰')}
        </button>
        <input
          aria-label={tr('选中文字颜色')}
          type="color"
          defaultValue="#222222"
          onChange={(e) => style({ color: e.target.value })}
        />
        <input
          aria-label={tr('选中文字字号')}
          type="number"
          min={propertyUnits(editor.state.doc, node.id).style}
          max={4096 * propertyUnits(editor.state.doc, node.id).style}
          defaultValue={node.fontSize * propertyUnits(editor.state.doc, node.id).style}
          onChange={(e) => {
            if (e.target.value) style({ fontSize: Number(e.target.value) / propertyUnits(editor.state.doc, node.id).style })
          }}
        />
        <select
          aria-label={tr('选中文字字体')}
          value={runFontId}
          onChange={(e) => style({ fontId: e.target.value || undefined })}
        >
          <option value="">{tr('跟随文本样式')}</option>
          <option value="default">{tr('Noto Sans SC（内置）')}</option>
          {Object.entries(editor.state.doc.fonts || {}).map(([id, font]) => (
            <option key={id} value={id}>
              {font.family}
            </option>
          ))}
        </select>
        <input
          aria-label={tr('选中文字字重')}
          type="number"
          min={1}
          max={1000}
          defaultValue={runWeight}
          onChange={(e) => {
            if (e.target.value) style({ weight: Math.min(1000, Math.max(1, Number(e.target.value))) })
          }}
        />
        <input
          aria-label={tr('文字链接')}
          type="url"
          placeholder="https://…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const link = e.currentTarget.value
              if (/^(https?:\/\/|mailto:)/.test(link)) style({ link })
              else setError('请输入 HTTP(S) 或邮件链接')
            }
          }}
        />
        <button type="button" onClick={() => finish(false, true)}>
          {tr('完成')}
        </button>
        <button type="button" onClick={() => finish(true, true)}>
          {tr('取消')}
        </button>
      </div>
      <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transformOrigin: '0 0',
        transform: `matrix(${matrix.join(',')})`,
        width: draft.width,
        minHeight: Math.max(draft.height, layout?.height || 0),
        zIndex: 20,
        background: 'transparent',
        pointerEvents: 'auto',
      }}
      >
      <svg
        width={draft.width}
        height={Math.max(draft.height, layout?.height || 0)}
        style={{ overflow: 'visible', display: 'block', outline: '1px solid #7755dd' }}
        onPointerDown={(e) => {
          e.preventDefault()
          const at = hit(e)
          anchor.current = e.shiftKey ? selection[0] : at
          select(anchor.current, at)
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (anchor.current !== null) select(anchor.current, hit(e))
        }}
        onPointerUp={() => {
          anchor.current = null
        }}
      >
        {layout?.glyphs
          .filter((g) => g.cluster < selection[1] && g.clusterEnd > selection[0])
          .map((g, i) => {
            const p = point(g.cluster)
            return (
              <rect key={i} x={g.x} y={p.flat.y} width={g.advance} height={p.height} transform={g.pathTransform?matrixString(g.pathTransform):undefined} fill="#0d99ff" fillOpacity={.2} />
            )
          })}
        {selection[0] === selection[1] && (
          <rect x={caret.flat.x} y={caret.flat.y} width={1} height={caret.height} transform={caret.pose?matrixString(caret.pose):undefined} fill="#7755dd" />
        )}
      </svg>
      <textarea
        ref={input}
        aria-label="画布文字编辑"
        value={draft.text}
        spellCheck={false}
        style={{
          position: 'absolute',
          left: caret.x,
          top: caret.y,
          width: 1,
          height: caret.height,
          opacity: 0,
          padding: 0,
          border: 0,
          resize: 'none',
        }}
        onChange={(e) => change(e.target.value)}
        onSelect={sync}
        onCompositionStart={() => {
          diagnostic.start(); diagnostic.event(InputPhase.compositionStart)
          composing.current = true
          pendingEditsChanged(editor)
        }}
        onCompositionEnd={(e) => {
          diagnostic.event(InputPhase.compositionEnd)
          composing.current = false
          change(e.currentTarget.value)
          if (blurred.current) finish()
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing.current) return
          navigate(e)
          if (e.key === 'Escape') {
            e.preventDefault()
            finish(true, true)
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            finish(false, true)
          }
        }}
      />
      </div>
      {error && <div role="alert" style={{ position: 'absolute', left: toolbarLeft, top: toolbarTop + toolbarSize.height, pointerEvents: 'auto' }}>{tr(error)}</div>}
    </div>
  )
}
