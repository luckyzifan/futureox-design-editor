import type { InterfaceLocale } from './interface-preference'
import { localizedToolCommands, unavailableReason } from './tool-registry'
/** Ephemeral UI metadata only. Never serialize into a document or history label. */
export type OperationStatus =
  | { key: 'exportPreviewGenerating' | 'exportFileReady' | 'sketchExportGenerating' | 'sketchExportReadyCompatibility' | 'openBlockedActiveOperation' | 'imageImportBlockedActiveOperation' | 'singleDesignFileRequired' | 'designImportComplete' | 'finishOrCancelDrag' | 'propertiesCopied' | 'sharedFontStyleNeedsLocalOverride' | 'instanceDetachHint' | 'importInputTooLarge' | 'importInputInvalid' | 'openCanvasBeforeImageImport' }
  | { key: 'importedGroupsAppended'; count: number }
  | { key: 'imageImportFailed' | 'saveFailedCanvasRetained' | 'kernelStartupFailed' | 'recoveryFailedAutosavePaused' | 'closeFailedDocumentRetained' | 'workspaceSwitchFailedDocumentRetained'; error: string }
  | { key: 'toolUnavailable' | 'unknownToolCommand'; commandId: string }
export type MessagePresentation = Readonly<{ raw: string; status: OperationStatus }>
/** Only explicitly tagged producers localize; arbitrary text is never interpreted. */
export function operationStatusText(raw: string, presentation: MessagePresentation | undefined, locale: InterfaceLocale): string {
  if (locale !== 'en' || !presentation || presentation.raw !== raw) return raw
  const status = presentation.status
  switch (status?.key) {
    case 'exportPreviewGenerating': return 'Generating export preview…'
    case 'exportFileReady': return 'Export file ready'
    case 'sketchExportGenerating': return 'Generating Sketch compatibility file…'
    case 'sketchExportReadyCompatibility': return 'Sketch compatibility file ready; also keep the .fd file for complete editing information'
    case 'openBlockedActiveOperation': return 'Finish the current operation before opening a file'
    case 'imageImportBlockedActiveOperation': return 'Finish the current operation before importing an image'
    case 'singleDesignFileRequired': return 'Import one design file at a time'
    case 'importedGroupsAppended': return `Appended ${status.count} groups; move them together or undo this import`
    case 'designImportComplete': return 'Import complete; you can continue editing'
    case 'openCanvasBeforeImageImport': return 'Open a canvas before importing an image'
    case 'importInputTooLarge': return 'Import file exceeds the 1 GiB (1,073,741,824 bytes) input limit'
    case 'importInputInvalid': return 'Invalid import file byte count'
    case 'imageImportFailed': return `Image import failed: ${status.error}`
    case 'saveFailedCanvasRetained': return `Save failed; the current canvas was retained: ${status.error}`
    case 'kernelStartupFailed': return `Design kernel failed to load: ${status.error}`
    case 'recoveryFailedAutosavePaused': return `Local recovery failed; autosave is paused: ${status.error}`
    case 'closeFailedDocumentRetained': return `Close request failed; the design was retained: ${status.error}`
    case 'workspaceSwitchFailedDocumentRetained': return `Workspace switch failed; the current design was retained: ${status.error}`
    case 'finishOrCancelDrag': return 'Finish dragging, or press Esc to cancel'
    case 'propertiesCopied': return 'Properties copied'
    case 'toolUnavailable': {
      const tool = localizedToolCommands(locale).find(entry => entry.id === status.commandId)
      return tool ? `“${tool.label}” is unavailable: ${unavailableReason(status.commandId, locale)}` : raw
    }
    case 'unknownToolCommand': return `Unknown tool command ${status.commandId}`
    case 'sharedFontStyleNeedsLocalOverride': return 'Selected text uses a shared style; enable “Convert to local text style” first'
    case 'instanceDetachHint': return 'Instance content derives from its main component: use “Detach instance” on the context menu to edit child layers'
    default: return raw
  }
}
