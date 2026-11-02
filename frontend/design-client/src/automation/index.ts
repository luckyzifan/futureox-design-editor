import { clipboardExtensions } from './clipboard'
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
import { shapeBuilderExtensions } from './shape-builder'
import type { AutomationExtension } from './types'
/** Single shared registry for live editor, embedded UI and MCP.
 * `extra` stays on this editor instance. The plugin host uses it for document plugin data and does not register that method in the end-user UI. */
export function createEditorDesignAutomation(editor: Editor, permissions?: AutomationPermissionPolicy, extra: readonly AutomationExtension[] = []) {
  return createDesignAutomation(editor, [
    ...designSystemExtensions, ...contextExtensions, ...exportExtensions, ...interactionExtensions, ...sketchExtensions, ...appExportExtensions, ...bulkExtensions, ...shapeBuilderExtensions, ...clipboardExtensions,
    ...extra,
  ], [validateDesignSystemDocument], permissions)
}
export * from './types'

export * from './permissions'
