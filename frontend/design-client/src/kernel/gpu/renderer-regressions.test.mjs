// Standalone Node >=24 renderer unit tests. No generated WASM, dependencies,
// browser or GPU is required. Uses the same cases as the Vitest suites and
// executes production renderer/graph/cache code with explicit driver doubles.
// Geometry/WASM boundaries fail loudly if an untested operation reaches them.
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

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
      source: kernelFunctions.map(unavailable).join('\n') }
    if (url === 'renderer-unit:geometry') return { format: 'module', shortCircuit: true,
      source: unavailable('inverse') }
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(source, { mode: 'transform' }).replaceAll('import.meta.env', '({ DEV: false })') }
    }
    return nextLoad(url, context)
  },
})
try {
  const { GpuRenderer } = await import('./renderer.ts')
  const { highZoomRegressions, imageResourceRegressions } = await import('./renderer-regression-cases.ts')
  highZoomRegressions(test, GpuRenderer)
  imageResourceRegressions(test, GpuRenderer)
} finally { hooks.deregister() }
