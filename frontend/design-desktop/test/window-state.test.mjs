import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fitWindowState, readWindowState, writeWindowState } from '../src/window-state.mjs'

const primary = { workArea: { x: 0, y: 25, width: 1440, height: 875 } }
test('disconnected screens and small displays retain a visible usable window', () => {
  const old = { version: 1, bounds: { x: -7000, y: -4000, width: 2200, height: 1400 }, maximized: true, fullscreen: false }
  const fitted = fitWindowState(old, [primary], primary)
  assert.deepEqual(fitted.bounds, { x: 0, y: 25, width: 1440, height: 875 })
  assert.equal(fitted.maximized, true)
  const small = { workArea: { x: -800, y: 0, width: 800, height: 600 } }
  const result = fitWindowState(old, [small], small)
  assert.deepEqual(result.bounds, { x: -800, y: 0, width: 800, height: 600 })
  assert.equal(result.minWidth, 800); assert.equal(result.minHeight, 600)
})
test('connected negative-coordinate screen and valid normal/maximized bounds are preserved', () => {
  const secondary = { workArea: { x: -1920, y: -50, width: 1920, height: 1080 } }
  const saved = { version: 1, bounds: { x: -1800, y: 40, width: 1200, height: 800 }, maximized: false, fullscreen: true }
  const fitted = fitWindowState(saved, [primary, secondary], primary)
  assert.deepEqual(fitted.bounds, saved.bounds)
  assert.equal(fitted.fullscreen, true)
  const bad = fitWindowState({ version: 1, bounds: { x: Infinity, y: 0, width: -1, height: 0 } }, [primary], primary)
  assert.ok(Number.isFinite(bad.bounds.x) && bad.bounds.width > 0 && bad.bounds.height > 0)
})
test('window preferences use bounded reads and atomic replacement without temporary leftovers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forma-window-state-'))
  const file = path.join(root, 'window.json')
  try {
    assert.equal(await readWindowState(file), null)
    const state = { version: 1, bounds: { x: 20, y: 30, width: 1200, height: 800 }, maximized: true, fullscreen: false }
    await writeWindowState(file, state)
    assert.deepEqual(await readWindowState(file), state)
    await writeWindowState(file, { ...state, bounds: { ...state.bounds, x: 100 } })
    assert.equal((await readWindowState(file)).bounds.x, 100)
    assert.deepEqual(await readdir(root), ['window.json'])
    await writeFile(file, '{bad preferences')
    await assert.rejects(readWindowState(file))
    assert.equal(await readFile(file, 'utf8'), '{bad preferences')
    await writeFile(file, ' '.repeat(4097))
    await assert.rejects(readWindowState(file), /size/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('display changes synchronize minimum before bounds and defer bounds until restored', async () => {
  const { constrainWindowToDisplays } = await import('../src/window-state.mjs')
  const calls = [], small = { workArea: { x: 0, y: 0, width: 800, height: 600 } }
  let maximized = false, fullscreen = false, bounds = { x: 0, y: 0, width: 1440, height: 940 }, minimum = [1000, 640]
  const window = { isDestroyed: () => false, isMaximized: () => maximized, isFullScreen: () => fullscreen,
    getNormalBounds: () => bounds, getMinimumSize: () => minimum,
    setMinimumSize: (w, h) => { minimum = [w, h]; calls.push(['minimum', w, h]) },
    setBounds: value => { bounds = value; calls.push(['bounds', value]) } }
  constrainWindowToDisplays(window, [small], small)
  assert.deepEqual(calls.map(x => x[0]), ['minimum', 'bounds']); assert.deepEqual(minimum, [800, 600])
  assert.deepEqual(bounds, { x: 0, y: 0, width: 800, height: 600 })
  for (const state of ['maximized', 'fullscreen']) {
    maximized = state === 'maximized'; fullscreen = state === 'fullscreen'; bounds = { x: 1500, y: 0, width: 1400, height: 900 }; minimum = [1000, 640]; calls.length = 0
    constrainWindowToDisplays(window, [small], small); assert.deepEqual(calls.map(x => x[0]), ['minimum'])
    maximized = false; fullscreen = false; constrainWindowToDisplays(window, [small], small)
    assert.deepEqual(bounds, { x: 0, y: 0, width: 800, height: 600 })
  }
})

test('host connects restore/move and display changes to the same constraint coordinator', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /for \(const event of \['unmaximize', 'leave-full-screen'\]\)/)
  assert.match(source, /ownedWindow\.on\(event, \(\) => constrainWindowToDisplays\(ownedWindow, screen\.getAllDisplays\(\), screen\.getPrimaryDisplay\(\)\)\)/)
  assert.match(source, /const constrainWindow = \(\) => constrainWindowToDisplays\(window, screen\.getAllDisplays\(\), screen\.getPrimaryDisplay\(\)\)/)
})


test('cross-display drag updates minimum without snapping intermediate bounds back', async () => {
  const { constrainWindowToDisplays } = await import('../src/window-state.mjs')
  const large = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }, small = { workArea: { x: 1440, y: 0, width: 800, height: 600 } }
  let bounds, minimum = [1000, 640]
  const mutations = []
  const window = { isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false,
    getNormalBounds: () => bounds, getMinimumSize: () => minimum,
    setMinimumSize: (w, h) => { minimum = [w, h] }, setBounds: next => { mutations.push(next); bounds = next } }
  for (const x of [100, 600, 900, 1200, 1440]) {
    bounds = { x, y: 30, width: 1000, height: 640 }
    const dragging = { ...bounds }
    constrainWindowToDisplays(window, [large, small], large, { fitBounds: false })
    assert.deepEqual(bounds, dragging)
  }
  assert.deepEqual(mutations, []); assert.deepEqual(minimum, [800, 600])
  // Removal/restore still performs a full fit, unlike a live drag.
  constrainWindowToDisplays(window, [small], small)
  assert.deepEqual(bounds, { x: 1440, y: 0, width: 800, height: 600 })
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /ownedWindow\.on\('move', \(\) => constrainWindowToDisplays\(ownedWindow, screen\.getAllDisplays\(\), screen\.getPrimaryDisplay\(\), \{ fitBounds: false \}\)\)/)
})
