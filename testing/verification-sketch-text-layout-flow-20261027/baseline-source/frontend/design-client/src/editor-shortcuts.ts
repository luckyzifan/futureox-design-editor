import type { Editor } from './engine'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { lockedSelectionIds } from './canvas-menu-model'
import { modalOwnsKeyboard, editableOwnsKeyboard } from './modal-keyboard'
import { resolveShortcut, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'
export function shortcutTargetOwnsKeyboard(target: EventTarget | null): boolean {
  return editableOwnsKeyboard(target) || modalOwnsKeyboard(target)
}
/** Runs the same command dispatcher as toolbar and context-menu actions. */
export async function dispatchEditorShortcut(editor: Editor, event: ShortcutKey & { target: EventTarget | null; preventDefault(): void }, context: ShortcutContext): Promise<boolean> {
  if (shortcutTargetOwnsKeyboard(event.target)) return false
  const binding = resolveShortcut(event, context)
  if (!binding) return false
  event.preventDefault()
  // Consume held destructive chords without creating additional history entries.
  if ((event.repeat && !binding.repeat) || editor.state.busy || editor.interactionActive) return true
  const command: EditorCommand = binding.command === 'toggle-lock' ? (lockedSelectionIds(editor).length ? 'unlock-selection' : 'lock-selection') :
    binding.command === 'toggle-visibility' ? (editor.state.selection.some(id => !editor.state.doc.nodes[id]?.visible) ? 'show-selection' : 'hide-selection') : binding.command
  await dispatchEditorCommand(editor, command, { zoomAnchor: editor.pointerScreen || undefined, shortcutProfile: context.profile })
  return true
}
