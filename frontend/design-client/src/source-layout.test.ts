import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('Sketch tools, zoom and preview share the 52px window toolbar', () => {
  const brand = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.editor-header > \.brand \{[^}]+\}/)?.[0]
  expect(brand).toBeTruthy()
  expect(brand).toContain('position: static')
  expect(brand).not.toContain('grid-column: 2')
  expect(css).toContain('grid-template-columns: 0 max-content minmax(0, 1fr) var(--workspace-inspector-width);')
  expect(css).toContain('grid-template-rows: 52px 1px minmax(0, 1fr) auto;')
  const header = css.match(/\.editor-shell\[data-ui-mode="sketch"\] > \.editor-header \{[^}]+\}/)?.[0]
  expect(header).toContain('display: flex')
  expect(header).toContain('grid-row: 1')
  expect(header).toContain('height: 52px')
  expect(header).toContain('max-height: 52px')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] .canvas-workspace')
  const canvas = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.canvas-workspace \{[^}]+\}/)?.[0]
  expect(canvas).toContain('grid-row: 3')
  expect(canvas).toContain('padding-top: 0')
  const toolbar = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.floating-toolbar \{[^}]+\}/)?.[0]
  expect(toolbar).toContain('position: relative')
  expect(toolbar).toContain('flex-wrap: nowrap')
  expect(toolbar).toContain('height: 52px')
  expect(toolbar).toContain('top: auto')
  expect(toolbar).toContain('bottom: auto')
  expect(toolbar).not.toContain('top: 8px')
  expect(toolbar).not.toContain('bottom: 12px')
  expect(css).toContain('.sketch-window-zoom')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] .properties-zoom { display: none; }')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] .properties-workspace { background: #ececec; padding-top: 0; grid-row: 3; }')
  expect(css).not.toContain('.editor-shell[data-ui-mode="sketch"] .floating-toolbar {\n  position: relative;\n  top: auto; right: auto; bottom: auto; left: auto; transform: none;\n  order: -1;')
})

test('source material names keep their own line under the page label', () => {
  expect(css).toContain('.source-row-copy { display:flex; flex-direction:column;')
  expect(css).toContain('.source-row-copy .source-row-name { white-space:normal;')
  expect(css).toContain('.source-page-inspector dl')
  expect(css).toContain('@media (min-width: 901px)')
  expect(css).toContain('width:max(300px, var(--workspace-layers-width, 248px))')
})
