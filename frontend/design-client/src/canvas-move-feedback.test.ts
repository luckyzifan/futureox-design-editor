import { expect, test } from 'vitest'
import { moveCanvasFeedback, concealCanvasFeedback, restoreCanvasFeedbackVisibility } from './canvas-move-feedback'

test('cached board movement translates its title and selection together without touching other titles', () => {
  const element = (owner: string | null, transform = '') => ({ style: { transform },
    getAttribute: () => owner }) as unknown as SVGElement
  const selection = element(null), title = element('moving'), other = element('stationary')
  const host = { querySelectorAll: () => [selection, title, other] } as unknown as ParentNode
  const originals = new Map<SVGElement, string>()
  moveCanvasFeedback(host, ['moving'], { x: 25.25, y: -17 }, originals)
  expect(title.style.transform).toBe(selection.style.transform)
  expect(title.style.transform).toBe('translate(25.25px,-17px)')
  expect(other.style.transform).toBe('')
  moveCanvasFeedback(host, ['moving'], { x: 40, y: 30 }, originals)
  for (const [node, original] of originals) node.style.transform = original
  expect(title.style.transform).toBe('')
  expect(selection.style.transform).toBe('')
})

test('fallback concealment preserves original visibility and ignores unrelated titles', () => {
  const element = (owner: string | null, visibility = '') => ({ style: { visibility },
    getAttribute: () => owner }) as unknown as SVGElement
  const selection = element(null, 'collapse'), title = element('moving'), other = element('stationary', 'visible')
  const host = { querySelectorAll: () => [selection, title, other] } as unknown as ParentNode
  const originals = new Map<SVGElement, string>()
  concealCanvasFeedback(host, ['moving'], originals)
  expect(selection.style.visibility).toBe('hidden')
  expect(title.style.visibility).toBe('hidden')
  expect(other.style.visibility).toBe('visible')
  restoreCanvasFeedbackVisibility(originals)
  expect(selection.style.visibility).toBe('collapse')
  expect(title.style.visibility).toBe('')
  expect(other.style.visibility).toBe('visible')
  expect(originals.size).toBe(0)
})
