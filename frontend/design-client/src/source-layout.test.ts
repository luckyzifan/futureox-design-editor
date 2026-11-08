import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('the Sketch file mark does not share the document title cell', () => {
  const brand = css.match(/\.editor-shell\[data-ui-mode="sketch"\] \.editor-header > \.brand \{[^}]+\}/)?.[0]
  expect(brand).toBeTruthy()
  expect(brand).toContain('grid-column: 1')
  expect(brand).not.toContain('grid-column: 2')
  expect(css).toContain('grid-template-columns: 44px max-content minmax(0, 1fr) var(--workspace-inspector-width);')
})

test('source material names keep their own line under the page label', () => {
  expect(css).toContain('.source-row-copy { display:flex; flex-direction:column;')
  expect(css).toContain('.source-row-copy .source-row-name { white-space:normal;')
  expect(css).toContain('.source-page-inspector dl')
  expect(css).toContain('@media (min-width: 901px)')
  expect(css).toContain('width:max(300px, var(--workspace-layers-width, 248px))')
})
