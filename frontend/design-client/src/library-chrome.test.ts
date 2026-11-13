import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { libraryHostKind, libraryRailVisible, type LibraryHostKind } from './library-chrome'
import type { UiMode } from './interface-preference'

const hosts: LibraryHostKind[] = ['web', 'desktop-files', 'desktop-workspace']
const layouts: UiMode[] = ['figma', 'sketch']

test('library host follows the desktop session and does not collapse web with desktop files', () => {
  expect(libraryHostKind(undefined)).toBe('web')
  expect(libraryHostKind(null)).toBe('web')
  expect(libraryHostKind({ supportsWorkspace: false })).toBe('desktop-files')
  expect(libraryHostKind({ supportsWorkspace: true })).toBe('desktop-workspace')
})

test('only Figma workspace drops the rail control that repeats the header library', () => {
  const visible = layouts.flatMap(layout => hosts.map(host => [layout, host, libraryRailVisible(layout, host)] as const))
  expect(visible.filter(([, , shown]) => !shown)).toEqual([['figma', 'desktop-workspace', false]])
  expect(libraryRailVisible('figma', 'desktop-files')).toBe(true)
  expect(libraryRailVisible('figma', 'web')).toBe(true)
  expect(libraryRailVisible('sketch', 'desktop-workspace')).toBe(true)
  expect(libraryRailVisible('sketch', 'desktop-files')).toBe(true)
  expect(libraryRailVisible('sketch', 'web')).toBe(true)
})

test('the shell keeps the header library entry at the narrow width that hides the plain header label, and neither layout shows the icon rail', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  expect(css).toContain('.editor-header .document-location, .editor-header .document-title > b, .editor-header .draft-badge { display: none; }')
  expect(css).toContain('@media (max-width: 1250px) {\n  .editor-shell .document-title .document-location { display: block; }\n}')
  expect(css).toContain('.editor-shell .workspace-rail { display: none; }')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] .workspace-rail { display: none; }')
  expect(css).toContain('.editor-shell .document-title .document-location:hover')
})
