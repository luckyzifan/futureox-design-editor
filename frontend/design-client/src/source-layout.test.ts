import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('neither layout reserves a far-left icon rail or mark column', () => {
  expect(css).toContain('.editor-shell .workspace-rail { display: none; }')
  expect(css).toContain('.editor-shell .document-title > .brand')
  expect(css).not.toContain('.editor-shell .editor-header > .brand')
  expect(css).not.toContain('.editor-shell[data-ui-mode="sketch"] .editor-header > .brand')
  expect(css).not.toMatch(/grid-template-columns:\s*(?:57|44|48)px/)
  expect(css).toContain('grid-template-columns: 0px max-content minmax(0, 1fr) var(--workspace-inspector-width);')
  expect(css).toContain('--editor-chrome-row: 53px;')
  expect(css).toContain('grid-template-rows: auto minmax(var(--editor-chrome-row), max-content) minmax(0, 1fr) auto;')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] .canvas-workspace')
  const canvas = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.canvas-workspace \{[^}]+\}/)?.[0]
  expect(canvas).toContain('grid-row: 3')
  expect(canvas).toContain('padding-top: 0')
  const toolbar = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.floating-toolbar \{[^}]+\}/)?.[0]
  expect(toolbar).toContain('position: relative')
  expect(toolbar).toContain('flex-wrap: wrap')
  expect(toolbar).toContain('top: auto')
  expect(toolbar).not.toContain('top: 8px')
})

test('source material names keep their own line under the page label', () => {
  expect(css).toContain('.source-row-copy { display:flex; flex-direction:column;')
  expect(css).toContain('.source-row-copy .source-row-name { white-space:normal;')
  expect(css).toContain('.source-page-inspector dl')
  expect(css).toContain('@media (min-width: 901px)')
  expect(css).toContain('width:max(300px, var(--workspace-layers-width, 240px))')
})
