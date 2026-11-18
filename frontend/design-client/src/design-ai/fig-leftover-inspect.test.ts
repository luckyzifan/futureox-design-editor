import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { matchBundledImportFonts } from '../bundled-import-fonts'
import { importFig } from '../import-fig'
import { validateDocument } from '../model'
import { userPages } from '../fig-document'

// Independently exported inputs are optional and never added to the repo.
const referenceDir = process.env.DESIGN_TEST_FIG_REFERENCE_DIR?.trim() || ''
const testReference = test.skipIf(!referenceDir)

async function imported(name: string) {
  const result = importFig(new Uint8Array(readFileSync(join(referenceDir, name))), name)
  const fonts = await matchBundledImportFonts(result.document)
  validateDocument(result.document)
  return { ...result, fonts }
}

testReference('gold-preview keeps ambiguous component properties and applies stroke overrides', async () => {
  const result = await imported('gold-preview.fig')
  const warnings = result.warnings.join('\n')
  expect(warnings).not.toContain('没有唯一目标')
  expect(warnings).not.toContain('styleIdForFill 暂不能执行')
  expect(warnings).not.toContain('strokePaints 暂不能执行')
  expect(warnings).not.toContain('矢量圆角')
  expect(warnings).not.toContain('顶点或区域样式')
  expect(userPages(result.document).map(page => page.name)).toEqual(['Page 1'])
  expect(result.document.pages.some(page => page.name === 'Internal Only Canvas')).toBe(true)
  expect(Object.keys(result.document.designSystem?.variables || {}).length).toBe(320)
  const properties = Object.values(result.document.nodes).flatMap(node => Object.values(node.component?.properties || {}))
  expect(properties.some(property => (property.alsoTargets?.length || 0) > 0)).toBe(true)
  expect(properties.some(property => property.unbound)).toBe(true)
  const strokes = Object.values(result.document.nodes).some(node =>
    Object.values(node.instance?.overrides || {}).some(fields => Array.isArray(fields.strokes) && fields.strokes.length > 0))
  expect(strokes).toBe(true)
})

testReference('large tiled fig no longer warns about unbaked vector corners', async () => {
  const result = await imported('01有料素材 (Copy) (1).fig')
  const warnings = result.warnings.join('\n')
  expect(warnings).not.toContain('矢量圆角')
  expect(warnings).not.toContain('顶点或区域样式')
  expect(result.document.pages.some(page => page.name === 'Internal Only Canvas')).toBe(true)
  expect(userPages(result.document).some(page => page.name === 'Internal Only Canvas')).toBe(false)
})

testReference('Poppins BoldItalic uses the italic file', async () => {
  const result = await imported('06-01有料素材.fig')
  expect(result.fonts.substitutions.some(item => item.from.includes('BoldItalic') && item.face.includes('Bold') && !item.face.includes('Italic'))).toBe(false)
  expect(result.fonts.missing.some(name => name.includes('BoldItalic'))).toBe(false)
  expect(Object.values(result.document.fonts || {}).some(face => face.postscript === 'Poppins-BoldItalic')).toBe(true)
})
