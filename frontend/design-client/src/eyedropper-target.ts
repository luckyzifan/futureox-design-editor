import type { Editor } from './engine'

export type PaintChannel = 'fill' | 'stroke'
const channels = new WeakMap<Editor, PaintChannel>()

/** The paint row last touched. The I shortcut writes this channel. */
export function rememberPaintChannel(editor: Editor | null | undefined, channel: PaintChannel) {
  if (editor) channels.set(editor, channel)
}

export function rememberedPaintChannel(editor: Editor): PaintChannel {
  return channels.get(editor) ?? 'fill'
}

/** Mac desktop Figma: I, and Control+C, start the sampler. Control+C is not copy on macOS. */
export function eyedropperChord(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, platform: 'mac' | 'other') {
  if (event.altKey || event.metaKey || event.shiftKey) return false
  const key = event.key.toLowerCase()
  if (!event.ctrlKey && key === 'i') return true
  return platform === 'mac' && event.ctrlKey && key === 'c'
}
