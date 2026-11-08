import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Users } from 'lucide-react'
import { AnchoredMenu } from './anchored-menu'
import type { Editor } from './engine'
import type { DesktopSession } from './desktop-session'
import { desktopBridge, type LocalPeer, type WorkspaceDocument } from './desktop'
export function useLocalWindows(editor: Editor, session: DesktopSession | undefined, ready: boolean) {
  const [peers, setPeers] = useState<LocalPeer[]>([]),
    [error, setError] = useState(''),
    [following, setFollowing] = useState<string | null>(null)
  const followingRef = useRef(following)
  followingRef.current = following
  useEffect(() => {
    const stop = (event: Event) => {
      if (
        followingRef.current &&
        event.target instanceof Element &&
        event.target.closest('[data-testid="canvas"],.properties-zoom')
      )
        setFollowing(null)
    }
    document.addEventListener('pointerdown', stop, true)
    document.addEventListener('wheel', stop, true)
    return () => {
      document.removeEventListener('pointerdown', stop, true)
      document.removeEventListener('wheel', stop, true)
    }
  }, [])
  useEffect(() => {
    const bridge = desktopBridge()?.live
    if (!ready || !session || !bridge) return
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      viewHash = '',
      heads: WorkspaceDocument[] = []
    const tick = async () => {
      try {
        const s = editor.state,
          canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]'),
          presented = document.querySelector<HTMLElement>('.kernel-presentation')
        let camera = presented
          ? {
              x: Number(presented.dataset.cameraX),
              y: Number(presented.dataset.cameraY),
              zoom: Number(presented.dataset.cameraZoom),
            }
          : s.view
        if (![camera.x, camera.y, camera.zoom].every(Number.isFinite) || camera.zoom <= 0) camera = s.view
        const width = canvas?.clientWidth || 1000,
          height = canvas?.clientHeight || 800
        const view: [number, number, number] = [
          (width / 2 - camera.x) / camera.zoom,
          (height / 2 - camera.y) / camera.zoom,
          camera.zoom,
        ]
        const screen = editor.pointerScreen
        const p = screen
          ? { x: (screen.x - camera.x) / camera.zoom, y: (screen.y - camera.y) / camera.zoom }
          : null
        const result = await bridge.observe({
          documentId: s.doc.id,
          pageId: s.page,
          view,
          cursor: p ? [p.x, p.y] : null,
          selection: s.selection,
          viewHash,
        })
        if (stopped) return
        if (result.status !== 'ok')
          throw new Error(result.status === 'cancelled' ? '本机联动已取消' : result.message)
        viewHash = result.viewHash
        if (result.documents) heads = result.documents
        if (editor.state.doc.id !== s.doc.id) return
        setPeers(result.peers)
        setError('')
        const head = heads.find((d) => d.id === editor.state.doc.id)
        if (head) await session.refreshLocalHead(head.id, head.revision)
        if (stopped) return
        const follow = result.peers.find((p) => p.id === followingRef.current)
        if (follow && !editor.interactionActive && editor.state.doc.pages.some((p) => p.id === follow.pageId))
          editor.set({
            page: follow.pageId,
            view: {
              x: width / 2 - follow.view[0] * follow.view[2],
              y: height / 2 - follow.view[1] * follow.view[2],
              zoom: follow.view[2],
            },
          })
        else if (followingRef.current && !follow) setFollowing(null)
      } catch (e) {
        if (!stopped) {
          setError(String(e))
          viewHash = ''
        }
      } finally {
        if (!stopped) timer = setTimeout(tick, document.hasFocus() ? 1000 : 3000)
      }
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [editor, session, ready])
  return { peers, error, following, setFollowing }
}
export function LocalWindowControl({
  editor,
  session,
  live,
}: {
  editor: Editor
  session: DesktopSession
  live: ReturnType<typeof useLocalWindows>
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const bridge = desktopBridge()?.live
  if (!bridge) return null
  async function newWindow() {
    if (editor.interactionActive || busy) return
    setBusy(true)
    setError('')
    try {
      if (!(await session.save())) return
      const result = await bridge!.openWindow({ id: editor.state.doc.id })
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '已取消' : result.message)
      setOpen(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="local-window-control" data-local-peers={live.peers.length}>
      <button ref={trigger} type="button" aria-label="本机窗口" title={`本机窗口：${live.peers.length + 1}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Users size={16} aria-hidden="true"/><span>{live.peers.length + 1}</span>
      </button>
      {open && createPortal(
        <AnchoredMenu anchor={trigger.current} className="local-window-popover" prefer="below" role="dialog" label="本机多窗口">
          <strong>本机窗口</strong>
          <button
            type="button"
            disabled={busy || session.status.busy || editor.interactionActive}
            onClick={() => void newWindow()}
          >
            在新窗口打开此设计
          </button>
          {live.peers.map((p) => (
            <button
              type="button"
              key={p.id}
              aria-pressed={live.following === p.id}
              onClick={() => live.setFollowing(live.following === p.id ? null : p.id)}
            >
              {p.name} · {live.following === p.id ? '停止跟随' : '跟随视图'}
            </button>
          ))}
          <p>共用本机文档库。未保存的编辑保留在各自窗口，版本冲突时可保存副本。</p>
          <button type="button" onClick={() => setOpen(false)}>
            关闭
          </button>
        </AnchoredMenu>,
        document.body,
      )}
      {(live.error || error) && (
        <span role="alert" title={live.error || error}>
          本机联动：{live.error || error}
        </span>
      )}
    </div>
  )
}
