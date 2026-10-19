import { expect, test, vi } from 'vitest'
import { WebGlDriver } from './webgl'
import type { GpuScene } from './types'

type ProgramLifetime = {
  managed: boolean
  modePrograms: Map<number, WebGLProgram>
  allowedModes: Set<number>
  compileMode: (mode: number) => WebGLProgram
  prepareScene(scene: GpuScene): Promise<void>
  compositorProgram(mode: number): WebGLProgram
}
function fixture() {
  // Exercise the production program ownership methods without substituting a
  // browser or shader compiler. Real compilation/parity is covered by GPU gates.
  const driver = Object.create(WebGlDriver.prototype) as ProgramLifetime
  driver.managed = true
  driver.modePrograms = new Map([[0, { mode: 0 } as unknown as WebGLProgram], [12, { mode: 12 } as unknown as WebGLProgram]])
  driver.allowedModes = new Set()
  driver.compileMode = vi.fn(mode => ({ mode }) as unknown as WebGLProgram)
  const scene = { nodes: { leaf: { blend: 'normal', fills: [], strokes: [], effects: [] } } } as unknown as GpuScene
  return { driver, scene }
}

test('scene preparation does not compile unused dispatches; submitted programs compile once', async () => {
  const { driver, scene } = fixture()
  await driver.prepareScene(scene)
  expect(driver.compileMode).not.toHaveBeenCalled()
  const background = driver.compositorProgram(12)
  expect(background).toBe(driver.modePrograms.get(12))
  const paint = driver.compositorProgram(2)
  expect(driver.compositorProgram(2)).toBe(paint)
  expect(driver.compileMode).toHaveBeenCalledExactlyOnceWith(2)
  expect(driver.modePrograms.has(30)).toBe(false)
  await driver.prepareScene(scene)
  expect(driver.compositorProgram(2)).toBe(paint)
  expect(driver.compileMode).toHaveBeenCalledTimes(1)
})

test('undeclared dispatch cannot silently compile, including independent filter and area pipelines', async () => {
  const { driver, scene } = fixture()
  await driver.prepareScene(scene)
  for (const mode of [4, 22, 31, 999, Number.NaN])
    expect(() => driver.compositorProgram(mode)).toThrow('not prepared')
  expect(driver.compileMode).not.toHaveBeenCalled()
})

test('preview presentation modes are permitted lazily and compilation failures are never cached', async () => {
  const { driver, scene } = fixture()
  await driver.prepareScene({ ...scene, presentation: {} } as GpuScene)
  for (const mode of [18, 33]) expect(driver.compositorProgram(mode)).toBe(driver.modePrograms.get(mode))
  expect(driver.compileMode).toHaveBeenCalledTimes(2)
  driver.compileMode = vi.fn(() => { throw Error('Compiler rejected exact shader') })
  expect(() => driver.compositorProgram(2)).toThrow('Compiler rejected exact shader')
  expect(driver.modePrograms.has(2)).toBe(false)
})

test('a new scene drops permissions for an uncompiled effect while retaining already compiled programs', async () => {
  const { driver, scene } = fixture()
  scene.nodes.leaf.effects = [{ kind: 'noise', visible: true }] as typeof scene.nodes.leaf.effects
  await driver.prepareScene(scene)
  expect(driver.allowedModes.has(7)).toBe(true)
  await driver.prepareScene({ ...scene, nodes: {} })
  expect(() => driver.compositorProgram(7)).toThrow('not prepared')
  expect(driver.compositorProgram(0)).toBe(driver.modePrograms.get(0))
  expect(driver.compileMode).not.toHaveBeenCalled()
})
