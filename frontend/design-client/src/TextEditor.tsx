import { ActionSource } from './canvas-action-diagnostics'
import { createInputDiagnostics, InputFamily, InputPhase } from './input-diagnostics'
import {apply,matrixString} from './geometry'
import { propertyUnits } from './property-units'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesignDocument, DesignNode, Matrix, TextRun } from './model'
import { replaceText, replaceTextRange, styleTextRange } from './text'
import { activateDocumentFonts, kernelTextLayout } from './kernel/picking'
import type { Editor } from './engine'
import { registerPendingEdit, pendingEditsChanged } from './pending-edits'
import { useProfessionalDialogText } from './professional-dialog-messages'
import { sourceFonts, storeRemappedSourceFonts, type FontResource, type FontSourceRecord } from './font-matching'
import { isBundledTypeface, loadBundledTypeface } from './bundled-import-fonts'
import { FontFaceOptions } from './FontFaceOptions'
import { withFontResource } from './font-management'
import { ImportOwner, importStep, type ImportRequest } from './import-ownership'
import { equalValue } from './document-patch'
import { interfacePreference } from './interface-preference'
import { matchesTypefaceShortcut, openTypefaceSelect } from './typeface-shortcut'
import { resolveShortcut, shortcutPlatform, shortcutProfileForUiMode } from './shortcut-profiles'
import { commitFigmaTextCommand, commitListIndent, figmaTextCommandRepeats, isFigmaTextCommand, textSelectionIsList } from './figma-text-shortcuts'

function comparableRuns(runs: DesignNode['textRuns']) {
  // Native layout may reorder fields and omit defaults when it returns runs.
  return (runs ?? []).map(run => Object.fromEntries(Object.entries(run).filter(([name, value]) =>
    value !== undefined && !(value === false && ['underline', 'italic', 'strikethrough'].includes(name)))))
}

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
          const cancel = !canvas || interfacePreference.getSnapshot().uiMode !== 'figma'
          if (cancel) {
            input.current!.value = original.current
            value.current = original.current
          }
          finish(cancel)
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
  onPreview: (node: DesignNode | null, fonts?: DesignDocument['fonts']) => void
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
    typeface = useRef<HTMLSelectElement>(null),
    composing = useRef(false),
    done = useRef(false),
    original = useRef(node),
    session = useRef(editor.sessionGeneration),
    blurred = useRef(false),
    anchor = useRef<number | null>(null),
    latest = useRef(draft)
  const [originalSource] = useState(() => sourceFonts(document, node))
  const editedSource = useRef<FontSourceRecord | undefined>(undefined)
  const beforeInputRange = useRef<[number, number] | null>(null)
  const typingStyle = useRef<{ offset: number; patch: Partial<TextRun> } | null>(null)
  const [fontRequests] = useState(() => new ImportOwner())
  const pendingFont = useRef<ImportRequest | undefined>(undefined)
  const finishAfterFont = useRef(false)
  const draftFonts = useRef<DesignDocument['fonts']>(undefined)
  const stagedFonts = draftFonts.current
  const previewFonts = useMemo(() => stagedFonts && { ...document.fonts, ...stagedFonts }, [document.fonts, stagedFonts])
  useEffect(() => { fontRequests.activate(); return () => fontRequests.dispose() }, [fontRequests])
  const draftChanged = () => latest.current.text !== original.current.text ||
    latest.current.fontSize !== original.current.fontSize ||
    !equalValue(latest.current.textStyle, original.current.textStyle) ||
    JSON.stringify(latest.current.textRuns) !== JSON.stringify(original.current.textRuns) ||
    (editedSource.current !== undefined && !equalValue(editedSource.current, originalSource))
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
  useLayoutEffect(() => { onPreview(draft, previewFonts) }, [draft, previewFonts, onPreview])
  useLayoutEffect(() => () => {
    if (draftFonts.current) activateDocumentFonts(editor.state.doc)
    onPreview(null)
  }, [editor, onPreview])
  let layout: ReturnType<typeof kernelTextLayout> | undefined
  try {
    if (previewFonts) activateDocumentFonts({ ...document, fonts: previewFonts })
    layout = kernelTextLayout(draft)
  } catch (e) {
    if (!error) queueMicrotask(() => setError(String(e)))
  }
  useEffect(() => {
    if (isCurrent && !isCurrent()) return
    input.current?.focus()
    input.current?.setSelectionRange(0, node.text.length)
  }, [node.id])
  useEffect(() => {
    const field = input.current
    if (!field) return
    const capture = () => { beforeInputRange.current = [field.selectionStart, field.selectionEnd] }
    field.addEventListener('beforeinput', capture)
    return () => field.removeEventListener('beforeinput', capture)
  }, [])
  const clearMovedTypingStyle = (start: number, end: number) => {
    const pending = typingStyle.current
    if (pending && (start !== end || start !== pending.offset)) typingStyle.current = null
  }
  const sync = () => {
    if (input.current) {
      const { selectionStart, selectionEnd } = input.current
      clearMovedTypingStyle(selectionStart, selectionEnd)
      setSelection([selectionStart, selectionEnd])
    }
  }
  const select = (a: number, b = a) => {
    clearMovedTypingStyle(a, b)
    input.current?.focus()
    input.current?.setSelectionRange(Math.min(a, b), Math.max(a, b), a > b ? 'backward' : 'forward')
    setSelection([Math.min(a, b), Math.max(a, b)])
  }
  const finish = (cancel = false, restoreCanvasFocus = false) => {
    if (isCurrent && !isCurrent()) return true
    if (done.current) return true
    if (composing.current) return false
    if (!cancel && pendingFont.current) {
      if (restoreCanvasFocus) finishAfterFont.current = true
      return false
    }
    const changed = draftChanged()
    if (!cancel && changed) {
      diagnostic.start()
      if (editor.sessionGeneration !== session.current || editor.state.doc.nodes[node.id] !== original.current) {
        diagnostic.valid(false)
        setError('图层已被修改，当前输入保留；请复制文字后取消')
        return false
      }
      const resultVersion = editor.state.version
      editor.update(
        [node.id],
        (n, doc) => {
          for (const id of new Set(latest.current.textRuns?.map(run => run.fontId))) {
            const resource = id && draftFonts.current?.[id]
            if (resource) doc.fonts = withFontResource(doc.fonts, id, resource)
          }
          n.text = latest.current.text
          n.fontSize = latest.current.fontSize
          if (latest.current.textStyle) n.textStyle = latest.current.textStyle
          else delete n.textStyle
          n.textRuns = latest.current.textRuns
          storeRemappedSourceFonts(doc, n.id, editedSource.current)
        },
        '编辑富文本',
      )
      const committed = editor.state.doc.nodes[node.id]
      const versionUpdated = resultVersion !== editor.state.version
      if (committed?.text !== latest.current.text ||
          committed.fontSize !== latest.current.fontSize ||
          !equalValue(committed.textStyle, latest.current.textStyle) ||
          !equalValue(comparableRuns(committed.textRuns), comparableRuns(latest.current.textRuns)) ||
          (editedSource.current && !versionUpdated)) {
        diagnostic.finish(false, false)
        return false
      }
    }
    if (cancel) diagnostic.cancel(); else diagnostic.finish(changed, true)
    fontRequests.invalidate()
    pendingFont.current = undefined
    finishAfterFont.current = false
    done.current = true
    pendingEditsChanged(editor)
    onClose(restoreCanvasFocus)
    return true
  }
  const commit = useRef(finish)
  commit.current = finish
  useEffect(() => registerPendingEdit(editor, {
    dirty: () => !done.current && (composing.current || !!pendingFont.current || draftChanged()),
    commit: () => commit.current(),
  }), [editor, node.id])
  const change = (text: string) => {
    diagnostic.start()
    let n = structuredClone(latest.current)
    const pending = typingStyle.current, source = editedSource.current ?? originalSource
    const [start, end] = beforeInputRange.current ?? selection
    beforeInputRange.current = null
    const addedEnd = text.length - (n.text.length - end)
    const atTypingCaret = pending && start === end && start === pending.offset
    const isInsertion = atTypingCaret && addedEnd > start &&
      text.slice(0, start) === n.text.slice(0, start) && text.slice(addedEnd) === n.text.slice(end)
    let fonts: FontSourceRecord | undefined
    if (isInsertion) {
      try {
        fonts = replaceTextRange(n, start, end, text.slice(start, addedEnd), source)
        fonts = styleTextRange(n, start, addedEnd, pending.patch, fonts ?? source) ?? fonts
        if ((n.textRuns?.length ?? 0) > 4096) throw new Error('文字样式区间超过 4096 段')
        pending.offset = addedEnd
      } catch {
        // Browser input can join graphemes across the caret. Keep the actual
        // input under the existing text edit path when the range is ambiguous.
        n = structuredClone(latest.current)
        fonts = replaceText(n, text, source)
      }
    } else fonts = replaceText(n, text, source)
    if (fonts) editedSource.current = fonts
    latest.current = n
    setDraft(n)
    pendingEditsChanged(editor)
    setError('')
    sync()
  }
  const style = (patch: Partial<TextRun>, range = selection, resource?: FontResource) => {
    diagnostic.start(); diagnostic.event(InputPhase.start, { fieldFamily: InputFamily.richStyle })
    try {
      const n = structuredClone(latest.current)
      const fonts = styleTextRange(n, ...range, patch, editedSource.current ?? originalSource)
      if (patch.fontId && resource) {
        const current = { ...editor.state.doc.fonts, ...draftFonts.current }
        if (withFontResource(current, patch.fontId, resource) !== current)
          draftFonts.current = { ...draftFonts.current, [patch.fontId]: resource }
      }
      if (fonts) editedSource.current = fonts
      latest.current = n
      setDraft(n)
      pendingEditsChanged(editor)
      setError('')
      if (!blurred.current) select(...range)
    } catch (e) {
      setError(String(e))
    }
  }
  const chooseFont = async (id: string) => {
    fontRequests.invalidate()
    pendingFont.current = undefined
    finishAfterFont.current = false
    const patch = { fontId: id || undefined }
    if (!isBundledTypeface(id) || selection[0] === selection[1]) {
      style(patch)
      pendingEditsChanged(editor)
      return
    }
    const request = fontRequests.begin(editor)
    const before = latest.current
    const range = selection
    pendingFont.current = request
    pendingEditsChanged(editor)
    try {
      const resource = await importStep(request, () => loadBundledTypeface(id, request.signal))
      const field = input.current
      if (done.current || composing.current || (isCurrent && !isCurrent()) || latest.current !== before ||
          editor.state.doc.nodes[node.id] !== original.current ||
          field?.selectionStart !== range[0] || field.selectionEnd !== range[1]) return
      style(patch, range, resource)
    } catch (error) {
      if (request.isCurrent()) {
        if (blurred.current) editor.notify(String(error))
        else setError(String(error))
      }
    } finally {
      request.finish()
      if (pendingFont.current === request) {
        pendingFont.current = undefined
        const restoreCanvasFocus = finishAfterFont.current
        finishAfterFont.current = false
        pendingEditsChanged(editor)
        if (blurred.current || restoreCanvasFocus) commit.current(false, restoreCanvasFocus)
      }
    }
  }
  const formatShortcut = (letter: string, field: HTMLTextAreaElement) => {
    const start = field.selectionStart, end = field.selectionEnd, node = latest.current
    const run = node.textRuns?.find(run => run.start <= start && (start < run.end || start === node.text.length && run.end === start))
    const pending = start === end && typingStyle.current?.offset === start ? typingStyle.current.patch : {}
    const weight = pending.weight ?? run?.weight ?? node.textStyle?.weight ?? 400
    const italic = Object.hasOwn(pending, 'italic') ? pending.italic : run?.italic
    const underline = Object.hasOwn(pending, 'underline') ? pending.underline : run?.underline
    const patch: Partial<TextRun> = letter === 'b' ? { weight: weight >= 600 ? 400 : 700 }
      : letter === 'i' ? { italic: italic ? undefined : true } : { underline: underline ? undefined : true }
    if (start < end) style(patch, [start, end])
    else typingStyle.current = { offset: start, patch: { ...pending, ...patch } }
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
          ref={typeface}
          aria-label={tr('选中文字字体')}
          value={runFontId}
          onChange={(e) => void chooseFont(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Escape' || e.nativeEvent.isComposing || interfacePreference.getSnapshot().uiMode !== 'sketch') return
            e.preventDefault()
            e.stopPropagation()
            select(...selection)
          }}
        >
          <option value="">{tr('跟随文本样式')}</option>
          <FontFaceOptions fonts={document.fonts} />
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
          const sketch = interfacePreference.getSnapshot().uiMode === 'sketch'
          if (sketch && matchesTypefaceShortcut(e.nativeEvent)) {
            const { selectionStart, selectionEnd } = e.currentTarget
            if (openTypefaceSelect(typeface.current)) {
              e.preventDefault()
              setSelection([selectionStart, selectionEnd])
            }
            return
          }
          const letter = e.key.toLowerCase()
          const primary = shortcutPlatform() === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
          if (sketch && primary && !e.altKey && !e.shiftKey && e.nativeEvent.keyCode !== 229 && ['b', 'i', 'u'].includes(letter)) {
            e.preventDefault()
            if (!e.repeat && !done.current && (!isCurrent || isCurrent())) formatShortcut(letter, e.currentTarget)
            return
          }
          const snapshot = interfacePreference.getSnapshot()
          const adopt = (selection: [number, number]) => {
            const committed = editor.state.doc.nodes[node.id]
            if (!committed) return
            original.current = committed
            const clone = structuredClone(committed)
            latest.current = clone
            setDraft(clone)
            select(selection[0], selection[1])
          }
          const flushDraft = () => {
            if (!draftChanged()) return true
            if (editor.sessionGeneration !== session.current || editor.state.doc.nodes[node.id] !== original.current) return false
            const version = editor.state.version
            editor.update([node.id], (n, doc) => {
              for (const id of new Set(latest.current.textRuns?.map(run => run.fontId))) {
                const resource = id && draftFonts.current?.[id]
                if (resource) doc.fonts = withFontResource(doc.fonts, id, resource)
              }
              n.text = latest.current.text
              n.fontSize = latest.current.fontSize
              if (latest.current.textStyle) n.textStyle = latest.current.textStyle
              else delete n.textStyle
              n.textRuns = latest.current.textRuns
              storeRemappedSourceFonts(doc, n.id, editedSource.current)
            }, '编辑富文本')
            if (editor.state.version === version) return false
            adopt([e.currentTarget.selectionStart, e.currentTarget.selectionEnd])
            return editor.state.doc.nodes[node.id] === original.current
          }
          if (primary && !e.altKey && letter === 'z') {
            e.preventDefault()
            if (!e.repeat && !draftChanged() && !done.current && (!isCurrent || isCurrent())) {
              if (e.shiftKey) editor.redo()
              else editor.undo()
              adopt([e.currentTarget.selectionStart, e.currentTarget.selectionEnd])
            }
            return
          }
          const shortcut = resolveShortcut(e.nativeEvent, {
            profile: shortcutProfileForUiMode(snapshot.uiMode), platform: shortcutPlatform(),
            uiMode: snapshot.uiMode, keyboardLayout: snapshot.figmaKeyboardLayout,
          })?.command
          if (shortcut && isFigmaTextCommand(shortcut)) {
            e.preventDefault()
            if ((e.repeat && !figmaTextCommandRepeats(shortcut)) || done.current || (isCurrent && !isCurrent())) return
            const range: [number, number] = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd]
            if (flushDraft() && commitFigmaTextCommand(editor, node.id, shortcut, range)) adopt(range)
            return
          }
          if (!sketch && (shortcut === 'bring-forward' || shortcut === 'send-backward')) {
            e.preventDefault()
            if (e.repeat || done.current || (isCurrent && !isCurrent())) return
            const range: [number, number] = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd]
            const direction = shortcut === 'bring-forward' ? 1 : -1
            if (!flushDraft()) return
            const current = editor.state.doc.nodes[node.id]
            if (current && textSelectionIsList(current, range)) {
              if (commitListIndent(editor, node.id, range, direction)) adopt(range)
            } else editor.reorder(direction > 0 ? 'forward' : 'backward')
            return
          }
          navigate(e)
          if (e.key === 'Escape') {
            e.preventDefault()
            finish(interfacePreference.getSnapshot().uiMode !== 'figma', true)
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
