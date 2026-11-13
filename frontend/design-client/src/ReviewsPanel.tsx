import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { useProfessionalDialogText } from './professional-dialog-messages'
import { uid, type LocalReview, type Point } from './model'
import { apply, inverse, worldMatrix } from './geometry'
import { commitPendingEdits, registerPendingEdit, pendingEditsChanged } from './pending-edits'
export function reviewPoint(editor: Editor, review: LocalReview): Point {
  return review.nodeId && editor.state.doc.nodes[review.nodeId]
    ? apply(worldMatrix(editor.state.doc, review.nodeId), review.position)
    : review.position
}
export function ReviewsPanel({ editor }: { editor: Editor }) {
  const { tr } = useProfessionalDialogText()
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot),
    [text, setText] = useState(''),
    [resolved, setResolved] = useState(false)
  const dirty = useRef(''),
    submitting = useRef(false),
    composing = useRef(false),
    input = useRef<HTMLTextAreaElement>(null)
  dirty.current = text
  useEffect(
    () =>
      registerPendingEdit(editor, {
        dirty: () => !!dirty.current || composing.current,
        commit: () => {
          if (submitting.current && !composing.current) return true
          input.current?.focus()
          editor.notify('请先保存或取消评论草稿')
          return false
        },
      }),
    [editor],
  )
  const current = s.doc.reviews?.find((r) => r.id === s.commentSelection),
    draft = s.commentDraft
  useEffect(() => setText(''), [s.commentSelection, draft, editor.sessionGeneration])
  const close = () => {
    if (!commitPendingEdits(editor)) return
    editor.set({ tool: 'select', commentDraft: undefined, commentSelection: undefined })
  }
  function submit() {
    if (!text.trim() || text.length > 10000 || composing.current) return
    submitting.current = true
    const ready = commitPendingEdits(editor)
    submitting.current = false
    if (!ready) return
    const message = { id: uid(), author: '本机用户', text: text.trim(), createdAt: Date.now() }
    if (draft) {
      const id = uid()
      editor.change(draft.kind === 'annotation' ? '添加标注' : '添加本地评论', (doc) => {
        const nodeId = draft.nodeId && doc.nodes[draft.nodeId] ? draft.nodeId : undefined
        const position = nodeId ? apply(inverse(worldMatrix(doc, nodeId)), draft.position) : draft.position
        ;(doc.reviews ??= []).push({
          id,
          pageId: s.page,
          nodeId,
          position,
          kind: draft.kind,
          resolved: false,
          messages: [message],
        })
      })
      editor.set({ commentDraft: undefined, commentSelection: id })
    } else if (current)
      editor.change('回复本地评论', (doc) => {
        doc.reviews!.find((r) => r.id === current.id)!.messages.push(message)
      })
    dirty.current = ''
    setText('')
    pendingEditsChanged(editor)
  }
  return (
    <aside
      className="inspector local-reviews"
      aria-label={tr('本地评论与标注')}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="panel-title">
        <strong>{tr(draft?.kind === 'annotation' ? '标注' : '评论')}</strong>
        <button aria-label={tr('关闭评论')} onClick={close}>
          ×
        </button>
      </header>
      <p className="muted">{tr('保存在本机设计文件中')}</p>
      <label>
        <input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} />
        {tr('显示已解决')}
      </label>
      {!draft && !current && <p>{tr('点击画布放置评论，或选择已有评论。')}</p>}
      {(s.doc.reviews || [])
        .filter((r) => r.pageId === s.page && (resolved || !r.resolved))
        .map((r) => (
          <button
            key={r.id}
            className="review-thread"
            aria-pressed={r.id === current?.id}
            onClick={() => {
              if (commitPendingEdits(editor)) editor.set({ commentSelection: r.id, commentDraft: undefined })
            }}
          >
            <span>
              {tr(r.kind === 'annotation' ? '标注' : '评论')} {r.resolved ? tr('· 已解决') : ''}
            </span>
            <span>{r.messages[0]?.text}</span>
            <small>{tr(`${r.messages.length} 条消息`)}</small>
          </button>
        ))}
      {current && (
        <section aria-label={tr('评论内容')}>
          {current.messages.map((m) => (
            <article key={m.id}>
              <strong>{m.author}</strong>
              <p style={{ whiteSpace: 'pre-wrap' }}>{m.text}</p>
            </article>
          ))}
          <button
            onClick={() =>
              editor.change(current.resolved ? '重新打开评论' : '解决评论', (d) => {
                d.reviews!.find((r) => r.id === current.id)!.resolved = !current.resolved
              })
            }
          >
            {tr(current.resolved ? '重新打开' : '标为已解决')}
          </button>
          <button
            onClick={() => {
              editor.change('删除本地评论', (d) => {
                d.reviews = d.reviews!.filter((r) => r.id !== current.id)
              })
              editor.set({ commentSelection: undefined })
            }}
          >
            {tr('删除评论')}
          </button>
        </section>
      )}
      {(draft || current) && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <textarea
            ref={input}
            onCompositionStart={() => {
              composing.current = true
              pendingEditsChanged(editor)
            }}
            onCompositionEnd={() => {
              composing.current = false
              pendingEditsChanged(editor)
            }}
            aria-label={tr(draft ? '评论正文' : '回复正文')}
            placeholder={tr(draft ? '添加评论…' : '回复…')}
            maxLength={10000}
            value={text}
            onChange={(e) => {
              dirty.current = e.target.value
              setText(e.target.value)
              pendingEditsChanged(editor)
            }}
            autoFocus
          />
          <button type="submit" disabled={!text.trim()}>
            {tr(current ? '保存回复' : draft?.kind === 'annotation' ? '保存标注' : '保存评论')}
          </button>
          {draft && (
            <button
              type="button"
              onClick={() => {
                dirty.current = ''
                setText('')
                editor.set({ commentDraft: undefined })
                pendingEditsChanged(editor)
              }}
            >
              {tr('取消')}
            </button>
          )}
        </form>
      )}
    </aside>
  )
}
