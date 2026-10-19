import type { Editor } from '../engine'
import { createDesignAutomation } from './core'
import { designSystemExtensions, validateDesignSystemDocument } from './design-system'
import { contextExtensions } from './context'
import { exportExtensions } from './export'
import { interactionExtensions } from './interactions'
import { sketchExtensions } from './sketch'
/** Single shared registry for live editor, embedded UI and MCP. */
export function createEditorDesignAutomation(editor: Editor) {
  return createDesignAutomation(editor, [
    ...designSystemExtensions, ...contextExtensions, ...exportExtensions, ...interactionExtensions, ...sketchExtensions,
  ], [validateDesignSystemDocument])
}
export * from './types'
