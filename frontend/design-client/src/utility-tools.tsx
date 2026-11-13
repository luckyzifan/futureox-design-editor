import { utilityAction, runUtilityAction, ActionSource, CanvasAction, ActionReason, type UtilityAction } from './canvas-utility-action'
import { boardObjects, resizeBoardObjects, boardToolNames, type BoardTool } from './board-tools'
import { reviewPoint } from './ReviewsPanel'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Editor, Tool } from './engine'
import { type Point, type DesignNode, type DesignDocument, type ConnectorEndpoint, paint, node, stroke, uid } from './model'
import { apply, inverse, worldMatrix, allParents, scene, pointInContours } from './geometry'
import { editableNetwork, materializeEditableNetwork } from './editable-network'
import {
  vector_tool_json,
  vector_fill_region_json,
  vector_translate_json,
} from './generated/design-kernel/design_kernel'
import { commitPendingEdits } from './pending-edits'
import { creationToolStaysArmed } from './shape-creation'
import { ERASER_SCREEN_PX, applyEraserEdits, eraserPreviewPatches, planVectorEraser, type EraserEdit } from './vector-eraser'
import { PEN_BLUE } from './pen-geometry'
import { useProfessionalDialogText } from './professional-dialog-messages'

export const utilityToolNames: Partial<Record<Tool, string>> = {
  multiselect: '多选',
  'text-path': '路径文本',
  'offset-path': '偏移路径',
  'paint-bucket': '油漆桶',
  comments: '评论',
  annotate: '标注',
  measure: '测量',
  'vector-lasso': '套索',
  bend: '弯折',
  cut: '裁切路径',
  eraser: '橡皮',
  eyedropper: '吸管',
}
export function vectorTool(
  node: DesignNode,
  action: 'nearest' | 'bend' | 'cut',
  point: Point,
  extra: Record<string, unknown> = {},
) {
  return JSON.parse(
    vector_tool_json(JSON.stringify({ network: editableNetwork(node), action, point, ...extra })),
  ) as { network: NonNullable<DesignNode['network']>; edge: string; parameter: number; distance: number }
}
export {pickSelectionColor as sampleScreenColor} from './canvas-color-picker'
import {pickSelectionColor as sampleScreenColor,hasCanvasColorPicker} from './canvas-color-picker'
type Gesture = {
  action: UtilityAction
  rejectedTargets: number
  selectionBefore: string[]
  verticesBefore: string[]
  pointer: number
  session: number
  page: string
  tool: Tool
  start: Point
  points: Point[]
  node?: DesignNode
  local?: Point
  edge?: string
  parameter?: number
  erased: Set<string>
  eraserSource?: DesignDocument
  eraserEdits?: EraserEdit[]
  scale: number
  origin: Point
  board?: ReturnType<typeof boardObjects>
  preview?: ReturnType<typeof boardObjects>
}
export function useUtilityTools(
  editor: Editor,
  tool: Tool,
  hit: (p: Point, deep: boolean, eligible?: (node: DesignNode) => boolean) => string | null,
  displayZoom: number,
) {
  const { tr } = useProfessionalDialogText()
  const drag = useRef<Gesture | null>(null),
    [drawing, setDrawing] = useState<{ tool: Tool; points: Point[] } | null>(null)
  const [preview, setPreview] = useState<ReturnType<typeof boardObjects> | null>(null)
  const cancel = (pointer?: number) => {
    if (typeof pointer === 'number' && drag.current?.pointer !== pointer) return
    if (drag.current) {
      editor.cancel()
      drag.current.action.cancel()
      drag.current = null
    }
    setDrawing(null)
    setPreview(null)
  }
  useLayoutEffect(() => {
    const active=drag.current
    if(active && active.tool===tool && active.session===editor.sessionGeneration && active.page===editor.state.page)return
    cancel()
  }, [tool, editor.sessionGeneration, editor.state.page])
  useLayoutEffect(() => {
    if (tool !== 'eyedropper' || editor.state.tool !== tool || hasCanvasColorPicker(editor)) return
    const controller = new AbortController()
    void sampleScreenColor(editor, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted && error?.name !== 'AbortError') editor.notify(String(error))
      })
    return () => controller.abort()
  }, [tool, editor])
  useEffect(() => {
    const blur = () => cancel()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        e.preventDefault()
        e.stopImmediatePropagation()
        cancel()
      }
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', blur)
      if (drag.current) { editor.cancel(); drag.current.action.cancel(ActionReason.sessionEnd) }
    }
  }, [editor])
  function connectorEnd(p: Point): ConnectorEndpoint {
    const id = hit(p, true, (n) => !n.connector && n.kind !== 'slice')
    let n = id && editor.state.doc.nodes[id]
    if (!n) return { point: p }
    const parents = allParents(editor.state.doc)
    for (let at = parents.get(n.id); at && editor.state.doc.nodes[at]; at = parents.get(at)) {
      const parent = editor.state.doc.nodes[at]
      if (parent.board) n = parent
    }
    const local = apply(inverse(worldMatrix(editor.state.doc, n.id)), p),
      x = Math.max(0, Math.min(1, local.x / n.width)),
      y = Math.max(0, Math.min(1, local.y / n.height)),
      edge = [x, 1 - x, y, 1 - y].indexOf(Math.min(x, 1 - x, y, 1 - y))
    return {
      point: p,
      nodeId: n.id,
      anchor: { x: edge === 0 ? 0 : edge === 1 ? 1 : x, y: edge === 2 ? 0 : edge === 3 ? 1 : y },
    }
  }
  function start(e: ReactPointerEvent, p: Point, zoom: number): boolean {
    // A menu action updates the editor synchronously; a pointer event can
    // arrive before React commits the new hook closure. Own the live tool.
    const tool=editor.state.tool
    if (
      !(tool in boardToolNames) &&
      ![
        'text-path',
        'offset-path',
        'paint-bucket',
        'comments',
        'annotate',
        'measure',
        'vector-lasso',
        'bend',
        'cut',
        'eraser',
        'eyedropper',
      ].includes(tool)
    )
      return false
    if (tool === 'eyedropper') return true // Async picker owns its lifecycle; no synthetic commit.
    const action = utilityAction(editor, tool === 'eraser' ? CanvasAction.eraser : tool in boardToolNames ? CanvasAction.boardCreate : tool === 'measure' ? CanvasAction.measure : tool === 'vector-lasso' ? CanvasAction.lasso : tool === 'bend' ? CanvasAction.bend : tool === 'offset-path' ? CanvasAction.offsetPath : tool === 'paint-bucket' ? CanvasAction.paintBucket : tool === 'text-path' ? CanvasAction.textPath : tool === 'comments' || tool === 'annotate' ? CanvasAction.review : CanvasAction.utility)
    if (tool === 'comments' || tool === 'annotate') {
      editor.set({
        commentSelection: undefined,
        commentDraft: {
          position: p,
          nodeId: hit(p, true) || undefined,
          kind: tool === 'comments' ? 'comment' : 'annotation',
        },
      })
      action.finish(true)
      return true
    }
    if (e.button !== 0 || !e.isPrimary || drag.current || !commitPendingEdits(editor)) { action.block(ActionReason.busy); return true }
    const g: Gesture = {
      action, rejectedTargets: 0, selectionBefore: [...editor.state.selection], verticesBefore: [...(editor.state.editingVertices || [])],
      pointer: e.pointerId,
      session: editor.sessionGeneration,
      page: editor.state.page,
      tool,
      start: p,
      points: [p],
      erased: new Set(),
      eraserSource: tool === 'eraser' ? editor.state.doc : undefined,
      scale: zoom,
      origin: { x: e.clientX - p.x * zoom, y: e.clientY - p.y * zoom },
    }
    try {
      if (tool.startsWith('connector-')) {
        const root = node('vector', p.x, p.y, 1, 1)
        root.name = boardToolNames[tool as BoardTool]
        root.strokes = [{ ...stroke('#333333', 2), endMarker: 'arrow' }]
        root.connector = {
          from: connectorEnd(p),
          to: { point: { x: p.x + 0.01, y: p.y } },
          style: tool === 'connector-straight' ? 'straight' : 'elbow',
        }
        g.board = { root: root.id, nodes: [root] }
      }
      if (!g.board && tool in boardToolNames) {
        const size = tool === 'table' ? [480, 192] : tool === 'code-block' ? [560, 240] : [240, 240]
        g.board = boardObjects(tool as BoardTool, { x: p.x, y: p.y, width: size[0], height: size[1] })
      }
      if (tool === 'text-path') {
        const id = editor.state.selection.length === 1 ? editor.state.selection[0] : hit(p, true),
          source = id && editor.state.doc.nodes[id]
        if (!source || ['text', 'frame', 'section', 'group', 'slice'].includes(source.kind)) {
          action.block(ActionReason.noTarget)
          editor.notify('请先选择一条连续路径')
          return true
        }
        const text = node('text', 0, 0, source.width, Math.max(source.height, 40))
        text.name = '路径文本'
        text.transform = worldMatrix(editor.state.doc, source.id)
        text.text = '沿路径输入文字'
        text.fontSize = 20
        text.fills = [paint('#242424')]
        text.textPath = { network: editableNetwork(source), offset: 0, normal: 0, reverse: false }
        editor.change(
          '创建路径文本',
          (doc) => {
            doc.nodes[text.id] = text
            doc.pages.find((p) => p.id === editor.state.page)!.children.push(text.id)
          },
          [text.id],
        )
        editor.set({ tool: 'select' })
        action.finish()
        return true
      }
      if (tool === 'paint-bucket') {
        const id = editor.state.selection.length === 1 ? editor.state.selection[0] : hit(p, true),
          n = id && editor.state.doc.nodes[id]
        if (!n || n.locked || ['frame', 'section', 'group', 'text', 'slice'].includes(n.kind)) {
          action.block(ActionReason.noTarget)
          editor.notify('请先选择矢量，再点击封闭区域')
          return true
        }
        const local = apply(inverse(worldMatrix(editor.state.doc, n.id)), p)
        const network = JSON.parse(
          vector_fill_region_json(
            JSON.stringify(editableNetwork(n)),
            local.x,
            local.y,
            n.fills.some((p) => p.visible),
          ),
        )
        editor.update(
          [n.id],
          (target) => {
            Object.assign(target, materializeEditableNetwork(n, network), {
              arc: undefined,
              cornerRadius: undefined,
            })
            if (!target.fills.some((p) => p.visible)) target.fills.push(paint(editor.state.pencil.color))
          },
          '切换矢量区域填充',
        )
        action.finish()
        return true
      }
      if (tool === 'bend' || tool === 'cut' || tool === 'offset-path') {
        const id =
            tool === 'offset-path' && editor.state.selection.length === 1
              ? editor.state.selection[0]
              : hit(p, true),
          n = id && editor.state.doc.nodes[id]
        if (!n || n.locked || ['frame', 'group', 'section', 'text', 'slice'].includes(n.kind)) {
          action.block(ActionReason.noTarget)
          editor.notify('请在可编辑矢量线段上操作')
          return true
        }
        const local = apply(inverse(worldMatrix(editor.state.doc, n.id)), p),
          pick = vectorTool(n, 'nearest', local)
        if (tool !== 'offset-path' && pick.distance > 8 / displayZoom) {
          action.block(ActionReason.noTarget)
          editor.notify('请靠近路径线段')
          return true
        }
        if (tool === 'cut') {
          const out = vectorTool(n, 'cut', local, {
            edge: pick.edge,
            parameter: pick.parameter,
            nonce: uid(),
          })
          editor.select([n.id])
          editor.update(
            [n.id],
            (target) =>
              Object.assign(target, materializeEditableNetwork(n, out.network), {
                arc: undefined,
                cornerRadius: undefined,
              }),
            '裁切路径',
          )
          action.finish()
          return true
        }
        Object.assign(g, { node: structuredClone(n), local, edge: pick.edge, parameter: pick.parameter })
        editor.select([n.id])
      }
      editor.begin(utilityToolNames[tool] || '画布操作')
      drag.current = g
      setDrawing({ tool, points: [p] })
      move(e, p)
      return true
    } catch (error) {
      action.cancel(ActionReason.validation)
      cancel()
      editor.notify(String(error))
      return true
    }
  }
  function move(e: ReactPointerEvent, p: Point): boolean {
    const g = drag.current
    if (!g) return false
    if (g.pointer !== e.pointerId || g.session !== editor.sessionGeneration || g.page !== editor.state.page)
      return true
    g.action.sample()
    p = { x: (e.clientX - g.origin.x) / g.scale, y: (e.clientY - g.origin.y) / g.scale }
    try {
      if (g.points.length >= 10000) throw new Error('手势超过10000个采样点，请分段操作')
      if (g.board?.nodes[0].connector) {
        g.preview = structuredClone(g.board)
        g.preview.nodes[0].connector!.to = connectorEnd(p)
        setPreview(g.preview)
      } else if (g.board) {
        const moved = Math.hypot(p.x - g.start.x, p.y - g.start.y) * g.scale >= 3,
          root = g.board.nodes[0]
        g.preview = moved
          ? resizeBoardObjects(g.board, {
              x: Math.min(p.x, g.start.x),
              y: Math.min(p.y, g.start.y),
              width: Math.abs(p.x - g.start.x),
              height: Math.abs(p.y - g.start.y),
            })
          : g.board
        setPreview(g.preview)
      }
      if (g.tool === 'offset-path' && g.node) {
        if(!editor.preview({ [g.node.id]: { pathOffset: (g.node.pathOffset || 0) + (p.x - g.start.x) } })){
          // A failed final sample must not commit a previous intermediate
          // offset, nor leave later samples outside the undo transaction.
          cancel();return true
        }
      } else if (g.tool === 'bend' && g.node && g.local) {
        const local = apply(inverse(worldMatrix(editor.state.doc, g.node.id)), p)
        const out = vectorTool(g.node, 'bend', g.local, {
          edge: g.edge,
          parameter: g.parameter,
          delta: { x: local.x - g.local.x, y: local.y - g.local.y },
        })
        editor.preview({
          [g.node.id]: {
            ...materializeEditableNetwork(g.node, out.network),
            arc: undefined,
            cornerRadius: undefined,
          },
        })
      } else if (g.tool === 'eraser' && g.eraserSource) {
        const last = g.points.at(-1)
        const samples = !last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6 ? [...g.points, p] : g.points
        const plan = planVectorEraser(g.eraserSource, g.page, samples, ERASER_SCREEN_PX / g.scale)
        g.eraserEdits = plan.edits
        g.erased = new Set(plan.edits.map(edit => edit.id))
        g.rejectedTargets = plan.rejected
        if (plan.edits.length && !editor.preview(eraserPreviewPatches(plan.edits))) { cancel(); return true }
      }
      if (g.tool in boardToolNames || g.tool === 'measure' || g.tool === 'bend') g.points = [g.start, p]
      else if (
        !g.points.length ||
        Math.hypot(p.x - g.points.at(-1)!.x, p.y - g.points.at(-1)!.y) > 1 / editor.state.view.zoom
      )
        g.points.push(p)
      setDrawing({ tool: g.tool, points: [...g.points] })
      return true
    } catch (error) {
      cancel()
      editor.notify(String(error))
      return true
    }
  }
  function end(e: ReactPointerEvent, p: Point): boolean {
    const g = drag.current
    if (!g) return false
    if (g.pointer !== e.pointerId) return true
    if (g.session !== editor.sessionGeneration || g.page !== editor.state.page) {
      cancel()
      return true
    }
    move(e, p)
    if (drag.current !== g) return true
    drag.current = null
    if (g.tool === 'bend' || g.tool === 'offset-path') editor.commit()
    else {
      editor.cancel()
      if (g.tool === 'vector-lasso' && g.points.length > 2) {
        const n =
          editor.state.selection.length === 1 ? editor.state.doc.nodes[editor.state.selection[0]] : undefined
        if (n && !['frame', 'section', 'group', 'text', 'slice'].includes(n.kind)) {
          const network = editableNetwork(n),
            matrix = worldMatrix(editor.state.doc, n.id)
          const ids = network.vertices
            .filter((v) => pointInContours(apply(matrix, v), [g.points]))
            .map((v) => v.id)
          editor.set({
            tool: 'vector',
            editingVertex: ids[0] || null,
            editingVertices: e.shiftKey
              ? [...new Set([...(editor.state.editingVertices || []), ...ids])]
              : ids,
          })
        } else {
          const entries = scene(editor.state.doc, editor.state.page)
          const ids = entries
            .filter(
              (entry) =>
                entry.depth === 0 &&
                !entry.locked &&
                pointInContours(
                  { x: entry.bounds.x + entry.bounds.width / 2, y: entry.bounds.y + entry.bounds.height / 2 },
                  [g.points],
                  'evenodd',
                ),
            )
            .map((e) => e.id)
          editor.select(e.shiftKey ? [...new Set([...editor.state.selection, ...ids])] : ids)
        }
      }
      if (g.board) {
        const result = g.preview || g.board
        editor.change(
          `创建${boardToolNames[g.tool as BoardTool]}`,
          (doc) => {
            if(result.fonts){for(const [id,font] of Object.entries(result.fonts)){if(doc.fonts?.[id]&&doc.fonts[id].data!==font.data)throw new Error('等宽字体标识冲突');if(!doc.fonts?.[id])(doc.fonts??={})[id]=font}}
          for (const n of result.nodes) doc.nodes[n.id] = n
            doc.pages.find((p) => p.id === editor.state.page)!.children.push(result.root)
          },
          [result.root],
        )
        if (!creationToolStaysArmed(g.tool)) editor.set({ tool: 'select' })
        setPreview(null)
      }
      if (g.tool === 'eraser' && g.eraserEdits?.length) {
        const keep = g.eraserEdits.flatMap(edit => edit.kind === 'update' ? [edit.id] : [])
        editor.change('橡皮擦除', (doc) => applyEraserEdits(doc, g.eraserEdits!), keep)
      }
    }
    if (g.tool === 'eraser' && !g.erased.size && g.rejectedTargets) g.action.block(ActionReason.validation, { targetCount: 0 })
    else {
      const selectionChanged = g.selectionBefore.join('\n') !== editor.state.selection.join('\n') || g.verticesBefore.join('\n') !== (editor.state.editingVertices || []).join('\n')
      g.action.finish(g.tool === 'measure' ? g.points.length > 1 : selectionChanged, { targetCount: g.erased.size, motionObserved: g.points.length > 1, selectionChanged, selectionBefore: g.selectionBefore.length, selectionAfter: editor.state.selection.length })
    }
    if (g.tool !== 'measure') setDrawing(null)
    return true
  }
  const overlay =
    drawing && drawing.points.length > 1 ? (
      <g pointerEvents="none" data-testid="utility-gesture">
        <polyline
          points={drawing.points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill={drawing.tool === 'vector-lasso' ? '#0d99ff16' : 'none'}
          stroke={drawing.tool === 'measure' ? '#f24822' : drawing.tool === 'eraser' ? 'none' : PEN_BLUE}
          strokeWidth={1 / displayZoom}
        />
        {drawing.tool === 'eraser' && drawing.points.length > 0 && (
          <circle data-testid="eraser-brush" cx={drawing.points.at(-1)!.x} cy={drawing.points.at(-1)!.y} r={ERASER_SCREEN_PX / displayZoom} fill="#0d99ff18" stroke={PEN_BLUE} strokeWidth={1 / displayZoom} />
        )}
        {drawing.tool === 'measure' &&
          (() => {
            const a = drawing.points[0],
              b = drawing.points.at(-1)!
            return (
              <text
                x={b.x + 8 / displayZoom}
                y={b.y - 8 / displayZoom}
                fontSize={12 / displayZoom}
                fill="#d53613"
              >
                {Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} · ΔX {(b.x - a.x).toFixed(2)} · ΔY{' '}
                {(b.y - a.y).toFixed(2)}
              </text>
            )
          })()}
      </g>
    ) : null
  const pins = (
    <g data-testid="review-pins">
      {(editor.state.doc.reviews || [])
        .filter((r) => r.pageId === editor.state.page && !r.resolved)
        .map((r, i) => {
          const p = reviewPoint(editor, r),
            zoom = displayZoom
          return (
            <g
              key={r.id}
              transform={`translate(${p.x} ${p.y}) scale(${1 / zoom})`}
              role="button"
              aria-label={`${tr(r.kind === 'annotation' ? '标注' : '评论')} ${i + 1}`}
              tabIndex={0}
              onPointerDown={(e) => {
                e.stopPropagation()
                runUtilityAction(editor, CanvasAction.review, ActionSource.pointer, () => editor.set({ tool: 'comments', commentSelection: r.id, commentDraft: undefined }), true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  runUtilityAction(editor, CanvasAction.review, ActionSource.keyboard, () => editor.set({ tool: 'comments', commentSelection: r.id, commentDraft: undefined }), true)
                }
              }}
            >
              <circle
                r={12}
                fill={r.kind === 'annotation' ? '#c46fe6' : '#0d99ff'}
                stroke="white"
                strokeWidth={2}
              />
              <text textAnchor="middle" y={4} fill="white" fontSize={11}>
                {i + 1}
              </text>
            </g>
          )
        })}
    </g>
  )
  return { start, move, end, cancel, overlay, pins, preview, active: () => !!drag.current }
}

export function translateVertices(
  network: NonNullable<DesignNode['network']>,
  ids: string[],
  delta: Point,
): NonNullable<DesignNode['network']> {
  return JSON.parse(vector_translate_json(JSON.stringify(network), JSON.stringify(ids), delta.x, delta.y))
}
