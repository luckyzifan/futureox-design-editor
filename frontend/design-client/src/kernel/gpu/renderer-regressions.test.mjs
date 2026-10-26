// Node renderer units with the generated Rust scene planner. No browser or
// GPU is required. Uses the same cases as the Vitest suites and
// executes production renderer/graph/cache code with explicit driver doubles.
// Geometry/WASM boundaries fail loudly if an untested operation reaches them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import {rendererTestTypes} from './renderer-test-types.mjs'
import './renderer-test-plan.mjs'

const rendererUrl = new URL('./renderer.ts', import.meta.url)
const rendererSource = readFileSync(rendererUrl, 'utf8')
const kernelFunctions = [...rendererSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*generated\/design-kernel\/design_kernel['"]/g)]
  .flatMap(match => match[1].split(',').map(name => name.trim()).filter(Boolean))
const unavailable = name => `export function ${name}(){throw new Error('Unexpected WASM boundary: ${name}')}`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/generated/design-kernel/design_kernel'))
      return { url: 'renderer-unit:kernel', shortCircuit: true }
    if (context.parentURL === rendererUrl.href && specifier === '../../geometry')
      return { url: 'renderer-unit:geometry', shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) url.pathname += '.ts'
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'renderer-unit:kernel') return { format: 'module', shortCircuit: true,
      source: kernelFunctions.filter(name=>name!=='compiled_scene_plan_json').map(unavailable).join('\n')+
        '\nexport {compiled_scene_plan_json} from '+JSON.stringify(new URL('./renderer-test-plan.mjs',import.meta.url).href) }
    if (url === 'renderer-unit:geometry') return { format: 'module', shortCircuit: true,
      source: unavailable('inverse') }
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      return { format: 'module', shortCircuit: true,
        source: rendererTestTypes(source,new URL(url).pathname).replaceAll('import.meta.env', '({ DEV: false })') }
    }
    return nextLoad(url, context)
  },
})
try {
  const { GpuRenderer } = await import('./renderer.ts')
  const { highZoomRegressions, imageResourceRegressions } = await import('./renderer-regression-cases.ts')
  const { translationRegressions } = await import('./translation-regression-cases.ts')
  const { renderBudgetDiagnostic } = await import('../render-diagnostics.ts')
  test('production allocation rejection owns a scalar summary and consumes pending budget state', () => {
    const renderer = new GpuRenderer({ name: 'webgpu', managed: false, scratchBytes: 0,
      create: (width, height) => ({ width, height, bytes: width * height * 4, resource: {} }) })
    renderer.scene = { coherentSamples: false, id: 'private-node', view: { x: 123, y: 456 } }
    renderer.frameBudget = 1000
    assert.throws(() => renderer.acquire({ x: 123, y: 456, w: 16, h: 32 }), error => {
      assert.equal(error.message, 'GPU 表面内存预算超限')
      assert.deepEqual(renderBudgetDiagnostic(error), { requestedBytes: 2048, workingBytes: 0,
        budgetBytes: 1000, width: 16, height: 32, coherent: false })
      assert.doesNotMatch(JSON.stringify(renderBudgetDiagnostic(error)), /private-|stack|view|"x"|"y"/)
      return true
    })
    assert.equal(renderer.lastBudgetFailure, undefined)
    assert.equal(renderer.acquire({ x: 0, y: 0, w: 1, h: 1 }).texture.bytes, 4)
    assert.equal(renderer.lastBudgetFailure, undefined)
  })
  test('optional admission failures are cleared by success, invalid admission and a new render attempt', async () => {
    const renderer = new GpuRenderer({ name: 'webgpu', managed: false, scratchBytes: 0 })
    renderer.scene = { coherentSamples: true }; renderer.frameBudget = 1000
    assert.equal(renderer.overBudget(1001), true)
    assert.deepEqual(renderer.lastBudgetFailure, { requestedBytes: 1001, workingBytes: 0, budgetBytes: 1000, coherent: true })
    assert.equal(renderer.overBudget(1), false)
    assert.equal(renderer.lastBudgetFailure, undefined)
    renderer.overBudget(1001)
    assert.throws(() => renderer.overBudget(NaN), /字节数/)
    assert.equal(renderer.lastBudgetFailure, undefined)
    renderer.overBudget(1001)
    await assert.rejects(renderer.render({ version: 0, extent: { x: 0, y: 0, w: 1, h: 1 } }), error => {
      assert.match(error.message, /版本/)
      assert.equal(renderBudgetDiagnostic(error), undefined)
      return true
    })
    assert.equal(renderer.lastBudgetFailure, undefined)
  })
  translationRegressions(test)
  highZoomRegressions(test, GpuRenderer)
  imageResourceRegressions(test, GpuRenderer)
} finally { hooks.deregister() }
