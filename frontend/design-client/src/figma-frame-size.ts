import type { Editor } from './engine'
import { interfacePreference } from './interface-preference'

type FrameSize = Readonly<{ width: number; height: number }>
const last = new WeakMap<Editor, { session: number; size: FrameSize }>()

/** The Frame tool remembers the last top-level creation in this file session. */
export function lastFigmaFrameSize(editor: Editor): FrameSize | undefined {
  const old = last.get(editor)
  return old?.session === editor.sessionGeneration ? old.size : undefined
}

export function rememberFigmaFrameSize(editor: Editor, id: string) {
  if (interfacePreference.getSnapshot().uiMode !== 'figma') return
  const { doc, page } = editor.state
  const frame = doc.nodes[id]
  if (frame?.kind !== 'frame' || frame.graphic || !doc.pages.find(item => item.id === page)?.children.includes(id)) return
  last.set(editor, { session: editor.sessionGeneration, size: { width: frame.width, height: frame.height } })
}
