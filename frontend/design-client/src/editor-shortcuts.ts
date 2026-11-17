import type { Editor } from './engine'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { lockedSelectionIds } from './canvas-menu-model'
import { modalOwnsKeyboard, editableOwnsKeyboard } from './modal-keyboard'
import { requestCommandSearch } from './command-search-session'
import { requestLayerFind } from './layer-find-session'
import { recordShortcutUse, requestShortcutReference } from './shortcut-reference-session'
import { editableFrameCrop } from './selection-properties'
import { resolveShortcut, shortcutContextForLayout, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'
export function shortcutTargetOwnsKeyboard(target: EventTarget | null): boolean {
  return editableOwnsKeyboard(target) || modalOwnsKeyboard(target)
}
/** Runs the same command dispatcher as toolbar and context-menu actions. */
export async function dispatchEditorShortcut(editor: Editor, event: ShortcutKey & { target: EventTarget | null; preventDefault(): void }, context: ShortcutContext): Promise<boolean> {
  if (shortcutTargetOwnsKeyboard(event.target)) return false
  const layout = shortcutContextForLayout(context)
  const binding = resolveShortcut(event, layout)
  if (!binding || binding.preserveFrameContents && !editableFrameCrop(editor)) return false
  event.preventDefault()
  if (!event.repeat && !editor.interactionActive && !editor.state.busy && layout.profile === 'figma-like') recordShortcutUse(binding)
  if (binding.command === 'open-command-search' || binding.command === 'open-layer-find' || binding.command === 'open-shortcut-reference') {
    if (!event.repeat && !editor.interactionActive) {
      if (binding.command === 'open-command-search') requestCommandSearch(event.target)
      else if (binding.command === 'open-layer-find') requestLayerFind(event.target)
      else requestShortcutReference(event.target)
    }
    return true
  }
  if (binding.command === 'toggle-layout-guides' || binding.command === 'toggle-pixel-grid' || binding.command === 'toggle-pixel-snapping') {
    if (!event.repeat && !editor.interactionActive) {
      if (binding.command === 'toggle-pixel-grid') editor.set({ pixelGrid: !editor.state.pixelGrid })
      else if (binding.command === 'toggle-pixel-snapping') editor.set({ snapPixels: !editor.state.snapPixels })
      else editor.set({ showAuthoredLayout: editor.state.showAuthoredLayout === false })
    }
    return true
  }
  // Consume held destructive chords without creating additional history entries.
  if ((event.repeat && !binding.repeat) || editor.state.busy || editor.interactionActive) return true
  if (binding.command === 'select-parent') {
    editor.selectParent()
    return true
  }
  const command: EditorCommand = binding.command === 'toggle-lock' ? (lockedSelectionIds(editor).length ? 'unlock-selection' : 'lock-selection') :
    binding.command === 'toggle-visibility' ? (editor.state.selection.some(id => !editor.state.doc.nodes[id]?.visible) ? 'show-selection' : 'hide-selection') : binding.command
  await dispatchEditorCommand(editor, command, {
    zoomAnchor: editor.pointerScreen || undefined,
    shortcutProfile: layout.profile,
    preserveFrameContents: binding.preserveFrameContents,
  })
  return true
}
