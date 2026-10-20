import type { Editor } from '../engine'
import type { AutomationPermissionPolicy } from './permissions'
import { createDesignAutomation } from './core'
import { designSystemExtensions, validateDesignSystemDocument } from './design-system'
import { contextExtensions } from './context'
import { exportExtensions } from './export'
import { interactionExtensions } from './interactions'
import { sketchExtensions } from './sketch'
import { appExportExtensions } from './app-export'
import { bulkExtensions } from './bulk'
/** Single shared registry for live editor, embedded UI and MCP. */
export function createEditorDesignAutomation(editor: Editor, permissions?: AutomationPermissionPolicy) {
  return createDesignAutomation(editor, [
    ...designSystemExtensions, ...contextExtensions, ...exportExtensions, ...interactionExtensions, ...sketchExtensions, ...appExportExtensions, ...bulkExtensions,
  ], [validateDesignSystemDocument], permissions)
}
export * from './types'

export * from './permissions'
