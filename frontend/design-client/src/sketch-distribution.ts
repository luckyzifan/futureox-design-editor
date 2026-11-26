import type { Editor } from './engine'

export type SketchDistributionChoice = 'pixels' | 'subpixels'
export type SketchDistributionRequest = {
  isCurrent: () => boolean
  apply: (choice: SketchDistributionChoice) => void
  cancel: () => void
}

const dialogs = new WeakMap<Editor, (request: SketchDistributionRequest) => void>()

export function bindSketchDistributionDialog(editor: Editor, open: (request: SketchDistributionRequest) => void) {
  dialogs.set(editor, open)
  return () => { if (dialogs.get(editor) === open) dialogs.delete(editor) }
}

export function sketchDistributionPrompt(editor: Editor) {
  return dialogs.get(editor)
}
