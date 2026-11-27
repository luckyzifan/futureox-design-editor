import type { Editor } from './engine'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { lockedSelectionIds } from './canvas-menu-model'
import { modalOwnsKeyboard, editableOwnsKeyboard } from './modal-keyboard'
import { requestCommandSearch } from './command-search-session'
import { requestLayerFind } from './layer-find-session'
import { recordShortcutUse, requestShortcutReference } from './shortcut-reference-session'
import { editableFrameCrop } from './selection-properties'
import { resolveShortcut, shortcutContextForLayout, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'
import { applyFigmaTextShortcut, figmaTextCommandRepeats, isFigmaTextCommand } from './figma-text-shortcuts'
import { commitPendingEdits } from './pending-edits'
export function shortcutTargetOwnsKeyboard(target: EventTarget | null): boolean {
  return editableOwnsKeyboard(target) || modalOwnsKeyboard(target)
}
// Consecutive digits are a percentage only while the same edit owner is current.
const opacityDigits = new WeakMap<Editor, {
  digit: number
  selection: readonly string[]
  version: number
  session: number
  page: string
  time: number
}>()
const OPACITY_DIGIT_INTERVAL_MS = 500

function applyOpacityDigit(editor: Editor, digit: number) {
  if (editor.state.tool !== 'select' || editor.state.busy || editor.interactionActive || !commitPendingEdits(editor)) return false
  const ids = editor.topSelection()
  if (!ids.length) return false
  const { selection, version, page } = editor.state
  const session = editor.sessionGeneration, now = performance.now(), previous = opacityDigits.get(editor)
  const pair = previous && previous.selection === selection && previous.version === version &&
    previous.session === session && previous.page === page && now - previous.time <= OPACITY_DIGIT_INTERVAL_MS
  const percent = pair ? previous.digit * 10 + digit : digit === 0 ? 100 : digit * 10
  editor.update(ids, { opacity: percent / 100 }, '设置图层不透明度')
  if (pair) opacityDigits.delete(editor)
  else opacityDigits.set(editor, { digit, selection: editor.state.selection, version: editor.state.version, session, page, time: now })
  return true
}

/** Runs the same command dispatcher as toolbar and context-menu actions. */
export async function dispatchEditorShortcut(editor: Editor, event: ShortcutKey & { target: EventTarget | null; preventDefault(): void }, context: ShortcutContext): Promise<boolean> {
  if (shortcutTargetOwnsKeyboard(event.target)) { opacityDigits.delete(editor); return false }
  const layout = shortcutContextForLayout(context)
  const binding = resolveShortcut(event, layout)
  if (binding?.command === 'opacity-digit') {
    if (event.repeat || !applyOpacityDigit(editor, Number(binding.combo))) return false
    event.preventDefault()
    recordShortcutUse(binding)
    return true
  }
  if (binding) opacityDigits.delete(editor)
  if (!binding) return false
  const action = binding.command
  if (isFigmaTextCommand(action)) {
    if ((event.repeat && !figmaTextCommandRepeats(action)) || editor.state.busy || editor.interactionActive) {
      event.preventDefault()
      return true
    }
    if (!applyFigmaTextShortcut(editor, action)) return false
    event.preventDefault()
    if (!event.repeat && layout.profile === 'figma-like') recordShortcutUse(binding)
    return true
  }
  if (action === 'keyboard-box-select' || binding.preserveFrameContents && !editableFrameCrop(editor)) return false
  event.preventDefault()
  if (!event.repeat && !editor.interactionActive && !editor.state.busy && layout.profile === 'figma-like') recordShortcutUse(binding)
  if (action === 'open-command-search' || action === 'open-quick-insert' || action === 'open-layer-find' || action === 'open-shortcut-reference') {
    if (!event.repeat && !editor.interactionActive) {
      if (action === 'open-command-search') requestCommandSearch(event.target)
      else if (action === 'open-quick-insert') requestCommandSearch(event.target, 'components')
      else if (action === 'open-layer-find') requestLayerFind(event.target)
      else requestShortcutReference(event.target)
    }
    return true
  }
  if (action === 'toggle-layout-guides' || action === 'toggle-pixel-grid' || action === 'toggle-pixel-snapping') {
    if (!event.repeat && !editor.interactionActive) {
      if (action === 'toggle-pixel-grid') editor.set({ pixelGrid: !editor.state.pixelGrid })
      else if (action === 'toggle-pixel-snapping') editor.set({ snapPixels: !editor.state.snapPixels })
      else editor.set({ showAuthoredLayout: editor.state.showAuthoredLayout === false })
    }
    return true
  }
  // Consume held destructive chords without creating additional history entries.
  if ((event.repeat && !binding.repeat) || editor.state.busy || editor.interactionActive) return true
  if (action === 'select-parent') {
    editor.selectParent()
    return true
  }
  const command: EditorCommand = action === 'toggle-lock' ? (lockedSelectionIds(editor).length ? 'unlock-selection' : 'lock-selection') :
    action === 'toggle-visibility' ? (editor.state.selection.some(id => !editor.state.doc.nodes[id]?.visible) ? 'show-selection' : 'hide-selection') : action
  await dispatchEditorCommand(editor, command, {
    zoomAnchor: editor.pointerScreen || undefined,
    shortcutProfile: layout.profile,
    preserveFrameContents: binding.preserveFrameContents,
  })
  return true
}
