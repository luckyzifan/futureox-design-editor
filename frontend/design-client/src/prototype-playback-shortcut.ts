import type { DesignDocument } from './model'

type ChordEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

function isEnter(event: ChordEvent) {
  return event.key === 'Enter' || event.code === 'Enter'
}

function isSpace(event: ChordEvent) {
  return event.code === 'Space' || (event.key === ' ' && (event.code == null || event.code === '' || event.code === 'Space'))
}

/** Mac desktop Figma presents with Option-Command-Return. Other platforms use Ctrl+Alt+Enter. */
export function presentPrototypeChord(event: ChordEvent, platform: 'mac' | 'windows' | 'linux'): boolean {
  if (event.shiftKey || !isEnter(event)) return false
  if (platform === 'mac') return event.metaKey && event.altKey && !event.ctrlKey
  return event.ctrlKey && event.altKey && !event.metaKey
}

/** Inline prototype preview is Shift+Space in the Figma layout on every platform. */
export function inlinePrototypePreviewChord(event: ChordEvent): boolean {
  if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
  return isSpace(event)
}

/** The current page contains a frame (画板). Sections and other shapes do not count. */
export function pageHasFrame(doc: DesignDocument, pageId: string): boolean {
  const page = doc.pages.find(item => item.id === pageId)
  if (!page) return false
  const seen = new Set<string>()
  const stack = [...page.children]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = doc.nodes[id]
    if (!node) continue
    if (node.kind === 'frame') return true
    if (node.children.length) stack.push(...node.children)
  }
  return false
}

/** Same start-node check the player uses, so the shortcut does not mount a throw. */
export function prototypePlaybackReady(doc: DesignDocument): boolean {
  const current = doc.prototype?.startNode || doc.pages[0]?.children[0]
  return !!current && !!doc.nodes[current]
}
