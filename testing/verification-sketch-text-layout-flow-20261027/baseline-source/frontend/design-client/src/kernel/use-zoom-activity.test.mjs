/** CPU-only hook scheduling contracts. These execute the production hook with
 * React's dispatcher and a controlled animation-frame clock, not a renderer. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import React from 'react'

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) url.pathname += '.ts'
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) }
    return next(url, context)
  },
})
const { useZoomActivity, useCameraActivity } = await import('./use-zoom-activity.ts')
hooks.deregister()

function activityHarness(t, hook = useZoomActivity) {
  const states = [], refs = [], effects = [], pending = new Map()
  let stateIndex = 0, refIndex = 0, effectIndex = 0, nextFrame = 0, layout = []
  const originalRequest = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => { pending.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => pending.delete(id)
  const dispatcher = {
    useState(initial) {
      const i = stateIndex++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
    },
    useRef(initial) { const i = refIndex++; return refs[i] ??= { current: initial } },
    useLayoutEffect(callback, deps) {
      const i = effectIndex++, previous = effects[i]
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) layout.push(() => {
        previous?.cleanup?.(); effects[i] = { deps, cleanup: callback() }
      })
    },
  }
  const dispose = () => {
    effects.forEach(effect => effect?.cleanup?.())
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
  }
  t.after(dispose)
  return {
    render(value, identity = 'document') {
      stateIndex = refIndex = effectIndex = 0; layout = []
      const internal = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internal.H
      let result
      try { internal.H = dispatcher; result = hook(value, identity) }
      finally { internal.H = previous }
      layout.forEach(callback => callback())
      return result
    },
    frame() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(0)) },
    get pending() { return pending.size },
  }
}

test('high-zoom changes remain active until two stable animation frames', t => {
  const h = activityHarness(t)
  assert.equal(h.render(16), false)
  assert.equal(h.render(32), true)
  h.frame(); assert.equal(h.render(32), true)
  h.frame(); assert.equal(h.render(32), false)
  assert.equal(h.pending, 0)
})

test('returning to the committed zoom still waits for two stable frames', t => {
  const h = activityHarness(t)
  assert.equal(h.render(32), false)
  assert.equal(h.render(31), true)
  h.frame()
  assert.equal(h.render(32), true)
  h.frame(); assert.equal(h.render(32), true)
  h.frame(); assert.equal(h.render(32), false)
})

test('rapid high-zoom reversals never publish a false idle frame', t => {
  const h = activityHarness(t)
  h.render(32)
  for (const value of [31, 32, 30, 32, 31.5, 32]) {
    assert.equal(h.render(value), true)
    h.frame()
  }
  assert.equal(h.render(32), true)
  h.frame(); assert.equal(h.render(32), false)
})

test('returning a pan to its previous camera remains active until settled', t => {
  const h = activityHarness(t, useCameraActivity)
  const view = { x: -1024.25, y: -512.5, zoom: 32 }
  h.render(view)
  assert.equal(h.render({ ...view, x: view.x + .25 }), true)
  h.frame(); assert.equal(h.render(view), true)
  h.frame(); assert.equal(h.render(view), true)
  h.frame(); assert.equal(h.render(view), false)
})

test('new documents and backend owners discard pending activity immediately', t => {
  const h = activityHarness(t)
  h.render(32, 'old'); h.render(31, 'old'); h.frame()
  assert.equal(h.render(2, 'new'), false)
  assert.equal(h.pending, 0)
  assert.equal(h.render(2, 'new'), false)
  assert.equal(h.render(3, 'new'), true)
  h.frame(); assert.equal(h.render(3, 'new'), true)
  h.frame(); assert.equal(h.render(3, 'new'), false)
})

test('unchanged renders do not postpone the settle countdown', t => {
  const h = activityHarness(t)
  h.render(1); h.render(32)
  for (let i = 0; i < 10; i++) assert.equal(h.render(32), true)
  h.frame()
  for (let i = 0; i < 10; i++) assert.equal(h.render(32), true)
  h.frame(); assert.equal(h.render(32), false)
})
