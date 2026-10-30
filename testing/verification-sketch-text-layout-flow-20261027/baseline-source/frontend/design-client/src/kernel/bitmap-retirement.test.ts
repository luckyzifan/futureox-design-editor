import { expect, test, vi } from 'vitest'
import { BitmapRetirement } from './bitmap-retirement'
test('shared bitmap closes once, only after its final active or inactive owner retires', () => {
  const close = vi.fn(), bitmap = { close } as unknown as ImageBitmap
  const a = { bitmap }, b = { bitmap }, retirement = new BitmapRetirement()
  retirement.retire([a], [a, b]); expect(a.bitmap).toBe(bitmap); expect(close).not.toHaveBeenCalled()
  retirement.retire([a], [b]); expect(a.bitmap).toBeUndefined(); expect(close).not.toHaveBeenCalled()
  retirement.retire([b], []); expect(close).toHaveBeenCalledOnce()
  retirement.retire([{ bitmap }, b], []); expect(close).toHaveBeenCalledOnce()
})
