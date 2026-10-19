// CPU-only component boundary tests. Actual React hooks/JSX and the production
// preview component run with explicit geometry/capture doubles; no DOM, WASM,
// browser, GPU, rasterization, or screenshot fidelity is claimed here.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { transformSync } from 'rolldown/experimental'
import React from 'react'

const componentUrl = new URL('./CanvasEditPreview.tsx', import.meta.url)
const mocks = {
  './retained-board-preview': `
    export const retainedBoardPlan = (document, page, selection) => { globalThis.__editPreviewTest.plans++;
      return selection.length === 1 ? { id: selection[0], source: document, box: { x: 0, y: 0, width: 100, height: 100 } } : null; };
    export const retainedBoardOffset = (plan, document) => { globalThis.__editPreviewTest.validations++;
      return {
      x: document.nodes[plan.id].transform[4] - plan.source.nodes[plan.id].transform[4],
      y: document.nodes[plan.id].transform[5] - plan.source.nodes[plan.id].transform[5] }; };
    export const retainedBoardTransformOffset = (plan, transform) => ({
      x: transform[4] - plan.source.nodes[plan.id].transform[4],
      y: transform[5] - plan.source.nodes[plan.id].transform[5] });
    export const captureBoardFrame = () => {
      const env = globalThis.__editPreviewTest; env.captures++;
      return env.pixels = { background: { style: {} }, foreground: { style: {} },
        width: 800, height: 600, crop: { x: 0, y: 0, width: 100, height: 100 },
        pixelRatio: env.ratio, devicePixelRatio: env.ratio };
    };`,
  './Renderer': 'export const Scene = () => null;',
  './edit-preview': 'export const movePreviewPlan = () => null; export const movePreviewOffset = () => null; export const retainedSvgMove = () => null;',
  './geometry': `export const matrixString = m => 'matrix(' + m.join(' ') + ')';
    export const allParents = () => { throw Error('Unexpected geometry boundary'); };
    export const worldMatrix = () => { throw Error('Unexpected geometry boundary'); };`,
  './kernel/presentation': 'export const useDevicePixelRatio = () => globalThis.__editPreviewTest.ratio;',
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === componentUrl.href && mocks[specifier])
      return { url: `preview-test:${specifier}`, shortCircuit: true }
    if (specifier === './geometry' && context.parentURL === new URL('./edit-preview.ts', import.meta.url).href)
      return { url: 'preview-test:./geometry', shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) url.pathname += '.ts'
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('preview-test:'))
      return { format: 'module', shortCircuit: true, source: mocks[url.slice('preview-test:'.length)] }
    if (url === componentUrl.href) {
      const result = transformSync(componentUrl.pathname, readFileSync(componentUrl, 'utf8'), { jsx: { runtime: 'automatic' } })
      assert.deepEqual(result.errors, [])
      return { format: 'module', shortCircuit: true, source: result.code }
    }
    if (url.startsWith('file:') && url.endsWith('.ts'))
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) }
    return next(url, context)
  },
})
const { CanvasEditPreview } = await import('./CanvasEditPreview.tsx')
const { supportsEditPreview } = await import('./edit-preview.ts')
hooks.deregister()

function fixture(t, { selection = [], vectorSupported = true, canCapture = false, ratio = 1 } = {}) {
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
  const env = globalThis.__editPreviewTest = { ratio, captures: 0, validations: 0, plans: 0 }
  const document = { id: 'doc', nodes: { board: { transform: [1, 0, 0, 1, 0, 0] } }, pages: [{ id: 'page', background: '#ffffff' }] }
  const props = { document, baseDocument: document, selection, pageId: 'page', view: { x: 0, y: 0, zoom: 1 },
    size: { width: 800, height: 600 }, visible: false, inputAt: 0, sourceHost: { current: { querySelectorAll: () => [] } },
    canCapture, control: { current: null }, vectorSupported }
  const slots = [], layouts = [], refs = new Map()
  let cursor = 0
  const changed = (old, deps) => !old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))
  const dispatcher = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value } },
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], value => { slots[i] = value }] },
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) slots[i] = { deps, value: fn() }; return slots[i].value },
    useLayoutEffect(fn, deps) { const i = cursor++, old = slots[i]; if (changed(old, deps)) {
      slots[i] = { deps }; layouts.push({ i, fn, cleanup: old?.cleanup })
    } },
  }
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  function commit(tree) {
    if (!tree || typeof tree !== 'object') return
    if (tree.props?.ref && typeof tree.type === 'string') {
      const ref = tree.props.ref
      let record = refs.get(ref)
      if (!record) {
        const element = { style: {}, dataset: {}, replaceChildren(...children) { children.forEach(child => { child.parentElement = this }) } }
        refs.set(ref, record = { element, style: {} })
      }
      for (const [key, value] of Object.entries(tree.props.style || {}))
        if (record.style[key] !== value) record.element.style[key] = value
      record.style = { ...tree.props.style }; ref.current = record.element
    }
    for (const child of [tree.props?.children].flat(Infinity)) commit(child)
  }
  function render(patch = {}) {
    Object.assign(props, patch); cursor = 0
    const old = internals.H; internals.H = dispatcher
    let tree
    try { tree = CanvasEditPreview.type(props) } finally { internals.H = old }
    // React mutates children before cleaning the parent function's layout hooks.
    commit(tree)
    for (const item of layouts) item.cleanup?.()
    for (const { i, fn } of layouts.splice(0)) slots[i].cleanup = fn()
    return tree
  }
  t.after(() => {
    slots.forEach(slot => slot?.cleanup?.()); delete globalThis.__editPreviewTest
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete globalThis[key] : globalThis[key] = value
  })
  return { props, env, render, host: () => slots[0].current }
}

test('layout cleanup cannot hide a newly visible vector edit preview', t => {
  const f = fixture(t); f.render(); f.render({ visible: true })
  assert.equal(f.host().style.visibility, 'visible')
})

test('exact-frame handover stays hidden after old visible-preview cleanup', t => {
  const f = fixture(t); f.render({ visible: true }); f.render({ visible: false })
  assert.equal(f.host().style.visibility, 'hidden')
  f.props.control.current.restore()
  assert.equal(f.host().style.visibility, 'hidden')
})

test('repeated edit, cancel, and exact handovers do not leave a stale overlay', t => {
  const f = fixture(t)
  for (let i = 0; i < 4; i++) {
    f.render({ visible: true }); assert.equal(f.host().style.visibility, 'visible')
    f.render({ visible: false }); assert.equal(f.host().style.visibility, 'hidden')
  }
})

test('revoking unsupported preview cannot cover the underlying exact renderer', t => {
  const f = fixture(t); f.render({ visible: true }); f.render({ vectorSupported: false })
  f.props.control.current.restore()
  assert.equal(f.host().style.visibility, 'hidden')
})

test('direct bitmap moves accept integer physical displacement and reject fractional displacement', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true, vectorSupported: false, ratio: 1.25 })
  f.render({ view: { x: 0, y: 0, zoom: 2 } }); f.render()
  const control = f.props.control.current, transform = [1, 0, 0, 1, .4, 0]
  assert.equal(control.covers(f.props.document, ['board'], f.props.view), true)
  assert.equal(control.apply(f.props.document, 'board', transform), true)
  assert.equal(f.env.pixels.foreground.style.transform, 'translate(0.8px,0px)')
  control.restore(); assert.equal(f.host().style.visibility, 'hidden')
  transform[4] = .2
  assert.equal(control.apply(f.props.document, 'board', transform), false)
  assert.equal(transform[4], .2)
  assert.equal(f.host().style.visibility, 'hidden')
})

test('fractional committed movement revokes captured preview while retaining vector fallback', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true })
  f.render(); f.render()
  const moved = { ...f.props.document, nodes: { board: { transform: [1, 0, 0, 1, .5, 0] } } }
  const tree = f.render({ document: moved, visible: true })
  assert.equal(tree.props['data-retained-board'], 'false')
  assert.equal(f.host().style.visibility, 'visible')
  assert.equal(f.props.control.current.covers(moved, ['board'], f.props.view), false)
})

test('DPR changes trigger recapture even when CSS viewport and camera are unchanged', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true, vectorSupported: false })
  f.render(); f.render(); assert.equal(f.env.captures, 1)
  f.env.ratio = 2; f.render()
  assert.equal(f.props.control.current.covers(f.props.document, ['board'], f.props.view), false)
  assert.equal(f.env.captures, 2)
  f.render(); assert.equal(f.props.control.current.covers(f.props.document, ['board'], f.props.view), true)
})

test('camera or viewport changes revoke the old bitmap before replacement capture is available', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true, vectorSupported: false })
  f.render(); f.render()
  f.render({ canCapture: false, view: { x: .25, y: 0, zoom: 1 }, size: { width: 801, height: 600 } })
  assert.equal(f.props.control.current.covers(f.props.document, ['board'], f.props.view), false)
  assert.equal(f.props.control.current.apply(f.props.document, 'board', [1, 0, 0, 1, 1, 0]), false)
  assert.equal(f.host().style.visibility, 'hidden')
})

test('managed documents cannot enter either unmanaged SVG or sRGB8 capture paths', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true, vectorSupported: false })
  const managed = { ...f.props.document, colorManagement: { workingSpace: 'display-p3' } }
  assert.equal(supportsEditPreview(managed, 'page'), false)
  f.render({ document: managed, baseDocument: managed }); f.render()
  assert.equal(f.env.captures, 0)
  assert.equal(f.props.control.current.covers(managed, ['board'], f.props.view), false)
  assert.equal(f.host().style.visibility, 'hidden')
})

test('3000-node retained drag validates each immutable document once without cloning the node map per pointer', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true, vectorSupported: false })
  const nodes = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`other-${i}`, { transform: [1, 0, 0, 1, i, i] }]))
  nodes.board = f.props.document.nodes.board
  let enumerations = 0
  f.props.document.nodes = new Proxy(nodes, { ownKeys(value) { enumerations++; return Reflect.ownKeys(value) } })
  f.render(); f.render()
  const validations = f.env.validations
  for (let x = 1; x <= 60; x++) {
    f.render() // Pointer feedback can re-render the surrounding Canvas tree.
    assert.equal(f.props.control.current.covers(f.props.document, ['board'], f.props.view), true)
    assert.equal(f.props.control.current.apply(f.props.document, 'board', [1, 0, 0, 1, x, 0]), true)
  }
  assert.equal(enumerations, 0, 'a retained pointer event must never spread/enumerate the unchanged node map')
  assert.equal(f.env.validations, validations, 'content validation is memoized by immutable document identity')
  const changed = { ...f.props.document }
  f.props.control.current.covers(changed, ['board'], f.props.view)
  f.props.control.current.covers(changed, ['board'], f.props.view)
  assert.equal(f.env.validations, validations + 1, 'a different document still gets a fresh validation')
})

test('camera-only recaptures reuse the document plan and active edits do not warm unused plans', t => {
  const f = fixture(t, { selection: ['board'], canCapture: true, vectorSupported: false })
  f.render(); f.render()
  for (let x = 1; x <= 10; x++) f.render({ view: { x, y: 0, zoom: 1 } })
  assert.equal(f.env.plans, 1)
  for (let x = 1; x <= 10; x++) f.render({ visible: true, document: { ...f.props.document } })
  assert.equal(f.env.plans, 1)
})
