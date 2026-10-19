// Export the same browser fixtures for the native GPU acceptance runner.
import {
  figmaFixture,
  referenceSize,
  referenceScale,
  type ReferenceCase,
} from '../src/figma-fixtures'
import { largeScene, deepScene } from '../src/stress-fixtures'
import { precisionFixtures } from '../src/kernel-regression-fixtures'
import { mkdir } from 'node:fs/promises'
const output = process.argv[2]
if (!output) throw new Error('Usage: bun scripts/native-fixtures.ts <output-directory>')
await mkdir(output, { recursive: true })
const cases: ReferenceCase[] = [
  'rectangle',
  'curve',
  'rotated-curve',
  'alpha-curve',
  'shadow',
  'layer-blur',
  'blur-radii',
  'coverage-overlap',
  'coverage-overlap-2x',
  'group-blur',
  'group-shadow',
  'group-inner-shadow',
  'backdrop-blur',
  'pass-through',
  'pass-through-opacity',
  'isolated-opacity',
  'pass-through-blur',
  'large-nested',
]
for (const kind of cases) {
  const document = figmaFixture(kind),
    size = referenceSize(kind)
  await Bun.write(
    `${output}/${kind}.json`,
    JSON.stringify({
      document,
      options: {
        pageId: document.pages[0].id,
        ...size,
        view: { x: 0, y: 0, zoom: referenceScale(kind) },
        transparent: kind === 'alpha-curve',
        grid: false,
        rasterProfile: 'figma',
      },
    }),
  )
}
for (const [name, document] of [
  ['large', largeScene()],
  ['deep', deepScene()],
] as const) {
  await Bun.write(
    `${output}/${name}.json`,
    JSON.stringify({
      document,
      options: {
        pageId: document.pages[0].id,
        width: 320,
        height: 192,
        view: name === 'large' ? { x: -6400, y: 3200, zoom: 0.0032 } : { x: 20, y: 20, zoom: 1 },
        transparent: true,
        grid: false,
        rasterProfile: 'figma',
      },
    }),
  )
}
for (const [i, document] of precisionFixtures().entries()) {
  const preview = document.name.includes('像素预览')
  await Bun.write(
    `${output}/precision-${i}.json`,
    JSON.stringify({
      document,
      options: {
        pageId: document.pages[0].id,
        width: 256,
        height: 192,
        view: { x: 0, y: 0, zoom: preview ? 1.375 : 1 },
        pixelPreview: preview ? (i === 3 ? 1 : 2) : undefined,
        transparent: true,
        grid: false,
        rasterProfile: 'figma',
      },
    }),
  )
}
console.log(`Exported ${cases.length + 7} native GPU fixtures`)
