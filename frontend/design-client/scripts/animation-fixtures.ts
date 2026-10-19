import { animationFixture } from '../src/animation-fixture'
import { mkdir } from 'node:fs/promises'
const path = process.argv[2]
if (!path) throw new Error('Provide an output directory')
await mkdir(path, { recursive: true })
const { doc, clipId } = animationFixture()
for (const timeMs of [0, 125, 300, 600, 900, 1200, 1800, 2400])
  await Bun.write(
    `${path}/${timeMs}.json`,
    JSON.stringify({
      document: doc,
      options: {
        pageId: doc.pages[0].id,
        width: 520,
        height: 320,
        view: { x: 0, y: 0, zoom: 1 },
        transparent: false,
        grid: false,
        rasterProfile: 'figma',
        animation: { clipId, timeMs },
      },
    }),
  )
