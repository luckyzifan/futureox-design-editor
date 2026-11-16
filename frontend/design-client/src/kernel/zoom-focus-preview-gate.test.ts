import { afterEach, expect, test, vi } from 'vitest'
import { KernelClient } from './client'
import { InteractionRenderer } from './interaction-renderer'
import { blank, effect, node, type DesignDocument } from '../model'
import type { InteractionProps } from './interaction-layers'

const worker = vi.hoisted(() => ({ jobs: [] as { options: { gpuRoots?: string[] } }[] }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {}
  dispose() {}
  moveResidentInteraction() {}
  stopResidentInteraction() {}
  releasePresented() {}
  render(_document: DesignDocument, options: { gpuRoots?: string[]; width: number; height: number }) {
    return new Promise(() => { worker.jobs.push({ options }) })
  }
} }))

const owners: InteractionRenderer[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); worker.jobs.length = 0 })

function scene(kind: 'extreme' | 'fitted' | 'remote') {
  const wide = kind === 'extreme'
  const doc = blank('zoom-focus')
  const image = node('rectangle', kind === 'remote' ? 10_000 : -20, kind === 'remote' ? 10_000 : -20, wide ? 240 : 16, wide ? 240 : 16)
  const ellipse = node('ellipse', 0, 0, 5, 5)
  ellipse.name = '椭圆 66'
  doc.schemaVersion = 19
  image.effects = [effect('gaussian-blur')]
  image.effects[0].radius = wide || kind === 'remote' ? 9.564871788024902 : 8
  ellipse.effects = [effect('zoom-blur')]
  ellipse.effects[0].radius = 0
  ellipse.effects[0].zoomBlur = { amount: 10, center: [0.5, 0.5] }
  doc.nodes = { [image.id]: image, [ellipse.id]: ellipse }
  doc.pages[0].children = [image.id, ellipse.id]
  return { doc, ellipse }
}

function focus(doc: DesignDocument, id: string, center: [number, number]) {
  const current = doc.nodes[id]
  const effects = current.effects.map((entry, index) => index === 0 && entry.zoomBlur
    ? { ...entry, zoomBlur: { amount: entry.zoomBlur.amount, center } } : entry)
  return { ...doc, nodes: { ...doc.nodes, [id]: { ...current, effects } } }
}

test.each(['analytic', 'figmaSubpixel'] as const)('%s 15060% DPR 2 zoom-focus drag does not submit the rejected whole-page preview', profile => {
  const { doc, ellipse } = scene('extreme')
  const failed = vi.fn()
  const owner = new InteractionRenderer(vi.fn(), new KernelClient())
  owners.push(owner)
  const view = { x: 0, y: 0, zoom: 150.6 }, size = { width: 800, height: 600 }
  const props = (document: DesignDocument, active = true): InteractionProps => ({
    document, selection: [ellipse.id], active, epoch: 1, gestureKind: 'parameter', control: { current: null }, onReady: vi.fn(), onPreviewFailed: failed,
  })
  const forward = focus(doc, ellipse.id, [0.8, 0.15])
  const back = focus(doc, ellipse.id, [0.2, 0.9])
  owner.prepare(props(doc), doc.pages[0].id, view, 2, profile, 'webgpu', undefined, size)
  owner.prepare(props(forward), doc.pages[0].id, view, 2, profile, 'webgpu', undefined, size)
  owner.prepare(props(back), doc.pages[0].id, view, 2, profile, 'webgpu', undefined, size)
  owner.prepare(props(forward), doc.pages[0].id, view, 2, profile, 'webgpu', undefined, size)
  expect(worker.jobs).toEqual([])
  expect(owner.control.isActive()).toBe(true)
  owner.control.end(forward)
  expect(owner.control.isActive()).toBe(false)
  expect(worker.jobs).toEqual([])
  expect(failed).not.toHaveBeenCalled()
  owner.prepare(props(doc, false), doc.pages[0].id, view, 2, profile, 'webgpu', doc, size)
  owner.prepare(props(forward, false), doc.pages[0].id, view, 2, profile, 'webgpu', forward, size)
  owner.prepare(props(doc), doc.pages[0].id, view, 2, profile, 'webgpu', undefined, size)
  owner.control.end(doc)
  expect(worker.jobs).toEqual([])
  expect(owner.control.isActive()).toBe(false)
  expect(failed).not.toHaveBeenCalled()
})

test('a fitting zoom-focus edit keeps the scoped layer preview and skips the whole page', () => {
  const { doc, ellipse } = scene('fitted')
  const owner = new InteractionRenderer(vi.fn(), new KernelClient())
  owners.push(owner)
  const view = { x: 0, y: 0, zoom: 100 }, size = { width: 400, height: 300 }
  const props = (document: DesignDocument): InteractionProps => ({
    document, selection: [ellipse.id], active: true, epoch: 1, gestureKind: 'parameter', control: { current: null }, onReady: vi.fn(),
  })
  owner.prepare(props(doc), doc.pages[0].id, view, 1, 'analytic', 'webgpu', undefined, size)
  owner.prepare(props(focus(doc, ellipse.id, [0.7, 0.3])), doc.pages[0].id, view, 1, 'analytic', 'webgpu', undefined, size)
  expect(worker.jobs.length).toBeGreaterThan(0)
  expect(worker.jobs.every(job => Array.isArray(job.options.gpuRoots) && job.options.gpuRoots.length > 0)).toBe(true)
})

test('an effect outside the preview viewport still uses the ordinary preview', () => {
  const { doc, ellipse } = scene('remote')
  const owner = new InteractionRenderer(vi.fn(), new KernelClient())
  owners.push(owner)
  owner.prepare({
    document: doc, selection: [ellipse.id], active: true, epoch: 1, gestureKind: 'parameter', control: { current: null }, onReady: vi.fn(),
  }, doc.pages[0].id, { x: 0, y: 0, zoom: 150.6 }, 2, 'analytic', 'webgpu', undefined, { width: 800, height: 600 })
  expect(worker.jobs.length).toBeGreaterThan(0)
})
