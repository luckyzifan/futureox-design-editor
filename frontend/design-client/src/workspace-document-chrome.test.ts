import { expect, test } from 'vitest'
import { workspaceDocumentChrome, type WorkspaceDocumentChrome } from './workspace-document-chrome'

const cases: Array<{ uiMode: 'figma' | 'sketch'; supportsWorkspace: boolean; sourceOpen: boolean } & WorkspaceDocumentChrome> = [
  { uiMode: 'figma', supportsWorkspace: true, sourceOpen: false, figmaHeaderTabs: true, windowTabBar: false, sketchSidebarDocuments: false },
  { uiMode: 'sketch', supportsWorkspace: true, sourceOpen: false, figmaHeaderTabs: false, windowTabBar: false, sketchSidebarDocuments: true },
  { uiMode: 'figma', supportsWorkspace: true, sourceOpen: true, figmaHeaderTabs: false, windowTabBar: true, sketchSidebarDocuments: false },
  { uiMode: 'sketch', supportsWorkspace: true, sourceOpen: true, figmaHeaderTabs: false, windowTabBar: true, sketchSidebarDocuments: false },
  { uiMode: 'figma', supportsWorkspace: false, sourceOpen: false, figmaHeaderTabs: false, windowTabBar: false, sketchSidebarDocuments: false },
  { uiMode: 'sketch', supportsWorkspace: false, sourceOpen: false, figmaHeaderTabs: false, windowTabBar: false, sketchSidebarDocuments: false },
]

test.each(cases)('document chrome $uiMode workspace=$supportsWorkspace source=$sourceOpen', (input) => {
  const chrome = workspaceDocumentChrome(input)
  expect(chrome).toEqual({
    figmaHeaderTabs: input.figmaHeaderTabs,
    windowTabBar: input.windowTabBar,
    sketchSidebarDocuments: input.sketchSidebarDocuments,
  })
  expect(chrome.figmaHeaderTabs && chrome.sketchSidebarDocuments).toBe(false)
  expect(chrome.windowTabBar && chrome.sketchSidebarDocuments).toBe(false)
  expect(chrome.windowTabBar && chrome.figmaHeaderTabs).toBe(false)
})
