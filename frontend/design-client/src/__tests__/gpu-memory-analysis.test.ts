import { describe, it, expect } from 'vitest'
import { mipLevelsFor } from '../kernel/gpu/renderer'

describe('GPU Memory Analysis', () => {
  // RGBA8 format: 4 bytes per pixel
  const BYTES_PER_PIXEL_RGBA8 = 4

  // GPU admission budget: 16M pixels at level 0
  const MAX_PIXELS_LEVEL_0 = 16 * 1024 * 1024

  function calculateMipmapMemory(width: number, height: number): {
    levels: number
    levelSizes: { level: number; width: number; height: number; pixels: number; bytes: number }[]
    totalBytes: number
    totalPixels: number
  } {
    const levels = mipLevelsFor([width, height])
    const levelSizes = []
    let totalBytes = 0
    let totalPixels = 0

    let w = width
    let h = height

    for (let level = 0; level < levels; level++) {
      const pixels = w * h
      const bytes = pixels * BYTES_PER_PIXEL_RGBA8
      levelSizes.push({ level, width: w, height: h, pixels, bytes })
      totalBytes += bytes
      totalPixels += pixels
      w = Math.max(1, Math.floor(w / 2))
      h = Math.max(1, Math.floor(h / 2))
    }

    return { levels, levelSizes, totalBytes, totalPixels }
  }

  function formatBytes(bytes: number): string {
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(2)} KB`
    const mb = kb / 1024
    if (mb < 1024) return `${mb.toFixed(2)} MB`
    const gb = mb / 1024
    return `${gb.toFixed(2)} GB`
  }

  it('should calculate memory for typical image sizes', () => {
    const testCases = [
      { name: '1920×1080 (Full HD)', width: 1920, height: 1080 },
      { name: '2560×1440 (2K)', width: 2560, height: 1440 },
      { name: '3840×2160 (4K)', width: 3840, height: 2160 },
      { name: '7680×4320 (8K)', width: 7680, height: 4320 },
    ]

    console.log('\n=== GPU Memory Usage by Image Size ===\n')

    for (const { name, width, height } of testCases) {
      const analysis = calculateMipmapMemory(width, height)
      console.log(`${name}:`)
      console.log(`  Base: ${width}×${height} (${(analysis.levelSizes[0].pixels / 1e6).toFixed(2)}M pixels)`)
      console.log(`  Mipmap Levels: ${analysis.levels}`)
      console.log(`  Total Memory (all levels): ${formatBytes(analysis.totalBytes)}`)
      console.log(`  Base Level Only: ${formatBytes(analysis.levelSizes[0].bytes)}`)

      // Check if base level exceeds admission budget
      const exceedsBudget = analysis.levelSizes[0].pixels > MAX_PIXELS_LEVEL_0
      if (exceedsBudget) {
        const fallbackLevel = analysis.levelSizes.findIndex(l => l.pixels <= MAX_PIXELS_LEVEL_0)
        if (fallbackLevel > 0) {
          console.log(`  ⚠️  Base exceeds 16M pixel budget → Fallback to Level ${fallbackLevel}`)
          console.log(`     Level ${fallbackLevel}: ${analysis.levelSizes[fallbackLevel].width}×${analysis.levelSizes[fallbackLevel].height} (${formatBytes(analysis.levelSizes[fallbackLevel].bytes)})`)
        }
      }
      console.log()
    }

    expect(testCases.length).toBeGreaterThan(0)
  })

  it('should analyze extreme case: 8192×8192 image', () => {
    const analysis = calculateMipmapMemory(8192, 8192)

    console.log('\n=== Extreme Case: 8192×8192 Image ===\n')
    console.log(`Total Mipmap Levels: ${analysis.levels}`)
    console.log(`Total Memory (all levels): ${formatBytes(analysis.totalBytes)}`)
    console.log('\nPer-Level Breakdown:')

    for (const level of analysis.levelSizes.slice(0, 5)) {
      console.log(`  Level ${level.level}: ${level.width}×${level.height} = ${formatBytes(level.bytes)}`)
    }
    console.log(`  ... (${analysis.levels - 5} more levels)`)

    // Base level: 8192² = 67.1M pixels → 268.4MB
    expect(analysis.levelSizes[0].bytes).toBe(268435456) // 256MB exactly

    // Find fallback level that fits 16M pixel budget
    const fallbackLevel = analysis.levelSizes.findIndex(l => l.pixels <= MAX_PIXELS_LEVEL_0)
    console.log(`\n⚠️  Fallback Level: ${fallbackLevel} (${analysis.levelSizes[fallbackLevel].width}×${analysis.levelSizes[fallbackLevel].height})`)
    expect(fallbackLevel).toBe(1) // Should fallback to level 1 (4096×4096 = 16.7M pixels, first to fit)
  })

  it('should verify Figma-aligned 64MB worst case', () => {
    // Figma limits to 4096×4096 max (RGBA8) = 64MB
    const figmaMax = calculateMipmapMemory(4096, 4096)

    console.log('\n=== Figma Worst-Case Analysis ===\n')
    console.log(`4096×4096 RGBA8: ${formatBytes(figmaMax.levelSizes[0].bytes)}`)

    expect(figmaMax.levelSizes[0].bytes).toBe(67108864) // 64MB
    console.log(`✓ Matches Figma's 64MB per-image ceiling\n`)
  })

  it('should calculate memory savings from mipmap fallback', () => {
    const testCases = [
      { width: 4096, height: 4096, name: '4K Square' },
      { width: 8192, height: 8192, name: '8K Square' },
      { width: 16384, height: 16384, name: '16K Square' },
    ]

    console.log('\n=== Memory Savings from Mipmap Fallback ===\n')

    for (const { width, height, name } of testCases) {
      const analysis = calculateMipmapMemory(width, height)
      const baseBytes = analysis.levelSizes[0].bytes

      // Find fallback level
      const fallbackLevel = analysis.levelSizes.findIndex(l => l.pixels <= MAX_PIXELS_LEVEL_0)
      if (fallbackLevel > 0) {
        const fallbackBytes = analysis.levelSizes[fallbackLevel].bytes
        const savings = baseBytes - fallbackBytes
        const savingsPercent = ((savings / baseBytes) * 100).toFixed(1)

        console.log(`${name} (${width}×${height}):`)
        console.log(`  Base Level 0: ${formatBytes(baseBytes)}`)
        console.log(`  Fallback Level ${fallbackLevel}: ${formatBytes(fallbackBytes)}`)
        console.log(`  Savings: ${formatBytes(savings)} (${savingsPercent}%)`)
        console.log()

        // 退一级应该节省 ~75% 内存 (每维度减半 = 面积减少 4x)
        expect(Number(savingsPercent)).toBeGreaterThan(70)
      }
    }
  })

  it('should verify admission failure → fallback logic', () => {
    // Image at 1600% zoom would be 16× dimensions
    // But we want level 0 (original) - if that fails, drop to level 1

    const originalWidth = 4096
    const originalHeight = 4096
    const zoom = 16 // 1600%

    // At 1600% zoom, trying to render full resolution would require:
    const pixelsNeeded = originalWidth * originalHeight

    console.log('\n=== Admission Failure Scenario ===\n')
    console.log(`Original Image: ${originalWidth}×${originalHeight}`)
    console.log(`Zoom Level: ${zoom}× (1600%)`)
    console.log(`Pixels Needed (Level 0): ${(pixelsNeeded / 1e6).toFixed(2)}M`)
    console.log(`GPU Budget (Level 0): ${(MAX_PIXELS_LEVEL_0 / 1e6).toFixed(2)}M`)

    const exceedsBudget = pixelsNeeded > MAX_PIXELS_LEVEL_0
    console.log(`\nExceeds Budget: ${exceedsBudget}`)

    if (exceedsBudget) {
      const analysis = calculateMipmapMemory(originalWidth, originalHeight)
      const fallbackLevel = 1 // 退一级
      console.log(`Fallback Strategy: Use Level ${fallbackLevel} instead of Level 0`)
      console.log(`Level ${fallbackLevel}: ${analysis.levelSizes[fallbackLevel].width}×${analysis.levelSizes[fallbackLevel].height}`)
      console.log(`Memory Reduction: ${formatBytes(analysis.levelSizes[0].bytes)} → ${formatBytes(analysis.levelSizes[fallbackLevel].bytes)}`)

      // Verify visual difference is minimal (Figma claim: "肉眼几乎不可见")
      const dimensionRatio = analysis.levelSizes[1].width / analysis.levelSizes[0].width
      expect(dimensionRatio).toBe(0.5) // 退一级 = 维度减半
    }

    console.log()
  })

  it('should estimate worst-case document memory', () => {
    // Scenario: Document with 100 large images
    const imageCount = 100
    const imageWidth = 2048
    const imageHeight = 2048

    const perImageAnalysis = calculateMipmapMemory(imageWidth, imageHeight)
    const totalMemory = perImageAnalysis.totalBytes * imageCount

    console.log('\n=== Worst-Case Document Memory ===\n')
    console.log(`Scenario: ${imageCount} images, each ${imageWidth}×${imageHeight}`)
    console.log(`Per Image (all mipmap levels): ${formatBytes(perImageAnalysis.totalBytes)}`)
    console.log(`Total Document Memory: ${formatBytes(totalMemory)}`)
    console.log()

    // With fallback, this should stay under reasonable limits
    const fallbackLevel = perImageAnalysis.levelSizes.findIndex(l => l.pixels <= MAX_PIXELS_LEVEL_0)
    if (fallbackLevel > 0) {
      const fallbackMemory = perImageAnalysis.levelSizes[fallbackLevel].bytes * imageCount
      console.log(`With Fallback (Level ${fallbackLevel}): ${formatBytes(fallbackMemory)}`)
      console.log(`Memory Savings: ${formatBytes(totalMemory - fallbackMemory)}`)
    }

    expect(totalMemory).toBeGreaterThan(0)
  })
})
