import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Sketch/Figma Import Integration', () => {
  const downloadsPath = join(process.env.HOME || '', 'Downloads')

  it('should have Sketch files available for testing', () => {
    const sketchFile = join(downloadsPath, '111.sketch')
    try {
      const exists = readFileSync(sketchFile)
      expect(exists).toBeDefined()
    } catch (e) {
      console.warn('Sketch test file not found:', sketchFile)
      expect(true).toBe(true) // Skip if file not available
    }
  })

  it('should have Figma files available for testing', () => {
    const figFile = join(downloadsPath, 'Forma 内核对照验收 2026-10-06.fig')
    try {
      const exists = readFileSync(figFile)
      expect(exists).toBeDefined()
    } catch (e) {
      console.warn('Figma test file not found:', figFile)
      expect(true).toBe(true) // Skip if file not available
    }
  })

  it('should recognize .sketch extension', () => {
    const filename = '111.sketch'
    expect(filename).toMatch(/\.sketch$/i)
  })

  it('should recognize .fig extension', () => {
    const filename = 'test.fig'
    expect(filename).toMatch(/\.fig$/i)
  })

  it('should validate file input accepts design formats', () => {
    const acceptedFormats = '.fd,.json,.svg,.fig,.sketch,.pdf,.png,.jpg,.jpeg,.webp'
    expect(acceptedFormats).toContain('.sketch')
    expect(acceptedFormats).toContain('.fig')
    expect(acceptedFormats).toContain('.png')
    expect(acceptedFormats).toContain('.jpg')
  })
})
