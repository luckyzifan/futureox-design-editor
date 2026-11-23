import { expect, test } from 'vitest'
import { figExportSettings } from './import-fig-properties'

test('svg outline text and bicubic sampling stay an incomplete export preset', () => {
  const svg = figExportSettings([{
    imageType: 'SVG', suffix: '', constraint: { type: 'CONTENT_SCALE', value: 1 },
    svgOutlineText: true, svgIDMode: 'IF_NEEDED', svgDataName: false,
    svgForceStrokeMasks: false, svgAnimated: false, contentsOnly: true,
    useAbsoluteBounds: false, colorProfile: 'DOCUMENT', useBicubicSampler: true,
  }])
  expect(svg.settings).toEqual([{ id: 'fig-export-0', format: 'svg', scale: 1, suffix: '' }])
  expect(svg.incomplete).toBe(true)

  const png = figExportSettings([{
    imageType: 'PNG', constraint: { type: 'CONTENT_SCALE', value: 1 }, suffix: '',
    contentsOnly: true, useAbsoluteBounds: false, colorProfile: 'DOCUMENT', useBicubicSampler: true,
  }])
  expect(png.settings).toEqual([{ id: 'fig-export-0', format: 'png', scale: 1, suffix: '' }])
  expect(png.incomplete).toBe(true)

  const plain = figExportSettings([{ imageType: 'PNG', suffix: '@2x', constraint: { type: 'CONTENT_SCALE', value: 2 } }])
  expect(plain.incomplete).toBe(false)
  expect(plain.settings[0]).toMatchObject({ format: 'png', scale: 2, suffix: '@2x' })

  const documentPng = figExportSettings([{
    imageType: 'PNG', constraint: { type: 'CONTENT_SCALE', value: 1 }, suffix: '',
    contentsOnly: true, useAbsoluteBounds: false, colorProfile: 'DOCUMENT', useBicubicSampler: false,
  }])
  expect(documentPng.incomplete).toBe(false)
})
