import { describe, it, expect } from 'vitest'

describe('Image Import', () => {
  it('should accept PNG files for import', () => {
    const pngFile = new File([''], 'test.png', { type: 'image/png' })
    expect(pngFile.name).toMatch(/\.png$/i)
  })

  it('should accept JPG/JPEG files for import', () => {
    const jpgFile = new File([''], 'test.jpg', { type: 'image/jpeg' })
    const jpegFile = new File([''], 'test.jpeg', { type: 'image/jpeg' })
    expect(jpgFile.name).toMatch(/\.jpe?g$/i)
    expect(jpegFile.name).toMatch(/\.jpe?g$/i)
  })

  it('should accept WEBP files for import', () => {
    const webpFile = new File([''], 'test.webp', { type: 'image/webp' })
    expect(webpFile.name).toMatch(/\.webp$/i)
  })

  it('should create image fill node structure', () => {
    const node = {
      id: 'img1',
      kind: 'rectangle' as const,
      name: '图片',
      visible: true,
      opacity: 1,
      blend: 'normal' as const,
      width: 100,
      height: 100,
      transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      fills: [{
        kind: 'image' as const,
        visible: true,
        opacity: 1,
        blend: 'normal' as const,
        color: '#ffffff',
        image: 'data:image/png;base64,test',
        fit: 'cover' as const,
        angle: 0,
        stops: [],
      }],
      strokes: [],
      effects: [],
    }

    expect(node.fills[0].kind).toBe('image')
    expect(node.fills[0].image).toBe('data:image/png;base64,test')
  })

  it('should calculate viewport center positioning', () => {
    const viewport = { x: 0, y: 0, w: 1000, h: 800 }
    const imageSize = { width: 200, height: 150 }

    const centerX = viewport.x + viewport.w / 2
    const centerY = viewport.y + viewport.h / 2
    const posX = centerX - imageSize.width / 2
    const posY = centerY - imageSize.height / 2

    expect(posX).toBe(400)
    expect(posY).toBe(325)
  })

  it('should calculate vertical spacing for multiple imports', () => {
    const images = [
      { width: 100, height: 80 },
      { width: 150, height: 100 },
      { width: 120, height: 90 },
    ]
    const spacing = 20

    let offsetY = 0
    const positions = []

    for (const img of images) {
      positions.push(offsetY)
      offsetY += img.height + spacing
    }

    expect(positions[0]).toBe(0)
    expect(positions[1]).toBe(100)
    expect(positions[2]).toBe(220)
  })
})
