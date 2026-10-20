import { expect, test } from 'vitest'
import { allowsReducedSampling, renderQualityContract } from './render-quality'

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
