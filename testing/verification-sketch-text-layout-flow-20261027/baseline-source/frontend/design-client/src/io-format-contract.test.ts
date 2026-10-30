import { expect, test } from 'vitest'
import { blank } from './model'
import { exportImage } from './export'

test.each(['jpg', 'psd', 'avif', 'gif', 'fig', '', 'PNG'])(
  'unsupported runtime format %j cannot succeed by returning an SVG', async (format) => {
    const doc = blank()
    await expect(exportImage(doc, doc.pages[0].id, format as 'png'))
      .rejects.toThrow('不支持的导出格式')
  },
)
