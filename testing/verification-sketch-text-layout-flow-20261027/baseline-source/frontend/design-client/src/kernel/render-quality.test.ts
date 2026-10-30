import { expect, test } from 'vitest'
import { allowsReducedSampling, renderQualityContract } from './render-quality'
import { hostRenderPolicy, usesDesktopDisplay } from './render-policy'

test('preview, settle and export contracts keep transport separate from quality', () => {
  for (const zoom of [NaN, Infinity, -1, 0, .01, .25, .25001, 1, 8]) {
    expect(allowsReducedSampling(zoom)).toBe(Number.isFinite(zoom) && zoom > 0 && zoom <= .25)
    for (const renderIntent of [undefined, 'preview', 'canvas', 'settle'])
      for (const png of [false, true]) for (const exportFormat of [undefined, 'png'])
        for (const exportRegion of [undefined, { x: 0 }]) for (const desktopFullMath of [false, true]) {
          const q = renderQualityContract({ renderIntent, png, exportFormat, exportRegion, desktopFullMath, zoom })
          const old = renderIntent === 'preview' && !desktopFullMath && !png && !exportFormat && !exportRegion
          expect(q.existingInteractiveEffectsPolicy).toBe(old)
          if (q.purpose !== 'preview') expect(q.reducedSamplingAllowed).toBe(false)
          if (png || exportFormat || exportRegion) expect(q.purpose).toBe('export')
        }
  }
})
test('desktop display does not authorize effect skipping or reduced normal-zoom coverage', () => {
  const policy = hostRenderPolicy(true, false, false, false, false, true)
  expect(usesDesktopDisplay(policy, { renderIntent: 'preview' })).toBe(true)
  for (const zoom of [.25, 1, 32]) {
    const quality = renderQualityContract({ ...policy, renderIntent: 'preview', zoom })
    expect(quality.existingInteractiveEffectsPolicy).toBe(false)
    expect(quality.reducedSamplingAllowed).toBe(zoom <= .25)
  }
  for (const renderIntent of ['canvas', 'settled']) {
    const quality = renderQualityContract({ ...policy, renderIntent, zoom: 1 })
    expect(quality.existingInteractiveEffectsPolicy).toBe(false)
    expect(quality.reducedSamplingAllowed).toBe(false)
  }
  expect(renderQualityContract({ ...policy, renderIntent: 'preview', png: true, zoom: 1 }).purpose).toBe('export')
})
