// Mounted accessibility contract, not a GUI/pixel-layout test.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { NumberField } from './fields'
import { MixedNumberField } from './MixedNumberField'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? d.window : d.window[key])
  return d
})
bootstrap.window.close()

test('ellipsized numeric labels retain full accessible names and explanatory titles without altering values', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://design.invalid' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'localStorage']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const mount = document.createElement('div'); document.body.append(mount)
  const root = createRoot(mount), onChange = vi.fn()
  const label = 'Exceptionally long localized minimum horizontal spacing'
  try {
    await act(async () => root.render(<div className="properties-content" style={{ width: 260 }}><div className="field-grid">
      <NumberField label={label} value={123456.789} onChange={onChange} />
      <MixedNumberField label={label} value={undefined} onChange={onChange} />
    </div></div>))
    const labels = [...mount.querySelectorAll<HTMLSpanElement>('.number-field > span')]
    expect(labels).toHaveLength(2)
    for (const item of labels) { expect(item.textContent).toBe(label); expect(item.title).toContain(label) }
    // NumberField's existing scrub instruction remains alongside the full label.
    expect(labels[0].title.length).toBeGreaterThan(label.length)
    const inputs = [...mount.querySelectorAll<HTMLInputElement>('input')]
    for (const input of inputs) expect(input.getAttribute('aria-label')).toBe(label)
    // Existing NumberField presentation rounds to two decimals, while its full
    // authored value remains exposed without an edit or callback.
    expect(inputs[0].value).toBe(String(Number((123456.789).toFixed(2))))
    expect(inputs[0].getAttribute('aria-valuenow')).toBe('123456.789')
    expect(inputs[0].title).toBe('123456.789'); expect(inputs[1].value).toBe('')
    expect(onChange).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})
