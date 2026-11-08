import { expect, test } from 'vitest'
import { benchFonts } from './cpu-bench-fonts'

test('CPU benches load DejaVu from the repo before a Linux system path', () => {
  const fonts = benchFonts()
  expect(fonts.sans.path.replaceAll('\\', '/')).toContain('public/fonts/dejavu/DejaVuSans.ttf')
  expect(fonts.serif.path.replaceAll('\\', '/')).toContain('public/fonts/dejavu/DejaVuSerif.ttf')
  expect(fonts.sans.bytes.byteLength).toBeGreaterThan(1000)
  expect(fonts.serif.bytes.byteLength).toBeGreaterThan(1000)
  expect(fonts.sans.path).not.toContain('/usr/share/fonts')
  expect(fonts.serif.path).not.toContain('/usr/share/fonts')
})
