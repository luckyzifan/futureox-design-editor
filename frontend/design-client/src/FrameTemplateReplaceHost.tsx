import { useEffect, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { FramePresetPanel } from './FramePresetPanel'
import { frameSizePresetGate } from './frame-presets'
import { closeFrameTemplate, frameTemplateFrameId, frameTemplateSnapshot, subscribeFrameTemplate } from './frame-template-session'

/** One apply-intent search for the top bar and Option-Command-R.
 * Selection, lock, and page changes close it without resizing. */
export function FrameTemplateReplaceHost({ editor }: { editor: Editor }) {
  const generation = useSyncExternalStore(subscribeFrameTemplate, frameTemplateSnapshot, () => 0)
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot, editor.panelSnapshot)
  const frameId = generation > 0 ? frameTemplateFrameId() : null
  const open = !!frameId && !state.busy && !editor.interactionActive && state.selection[0] === frameId
    && frameSizePresetGate(state.doc, state.page, state.selection, editor.parentMap(), frameId) === 'ready'
  useEffect(() => {
    if (generation > 0 && !open) closeFrameTemplate()
  }, [generation, open])
  if (!open) return null
  return <FramePresetPanel editor={editor} intent="apply" onClose={closeFrameTemplate} />
}
