import type { UiMode } from './interface-preference'

export type WorkspaceDocumentChrome = Readonly<{
  /** Figma keeps open documents in the window header. */
  figmaHeaderTabs: boolean
  /** Full-width strip under the window toolbar. Sketch editing does not use this. */
  windowTabBar: boolean
  /** Open documents sit in the left bar, above the current document's pages and layers. */
  sketchSidebarDocuments: boolean
}>

/** Sketch editing splits documents from pages and layers. Figma and the source viewer stay put. */
export function workspaceDocumentChrome(input: {
  uiMode: UiMode
  supportsWorkspace: boolean
  sourceOpen: boolean
}): WorkspaceDocumentChrome {
  const figmaHeaderTabs = input.uiMode === 'figma' && input.supportsWorkspace && !input.sourceOpen
  const sketchSidebarDocuments = input.uiMode === 'sketch' && input.supportsWorkspace && !input.sourceOpen
  return {
    figmaHeaderTabs,
    sketchSidebarDocuments,
    windowTabBar: input.supportsWorkspace && !figmaHeaderTabs && !sketchSidebarDocuments,
  }
}
