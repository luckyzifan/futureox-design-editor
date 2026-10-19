// Electron GPU diagnostics tool
// Injected into render process to monitor tile rendering and GPU usage

type Viewport = {
  camera: { zoom: number; x: number; y: number }
  width: number
  height: number
  devicePixelRatio: number
}

type DensityHistoryEntry = {
  time: number
  zoom: number
  density: number
}

declare global {
  interface Window {
    __renderTile?: (...args: unknown[]) => unknown
    __calculateDynamicDensity?: (viewport: Viewport) => number
    __gpuDiagnostics?: {
      tileRenders: number
      densityChanges: number
      lastDensity: number
      renderTimes: number[]
      densityHistory: DensityHistoryEntry[]
      printReport: () => void
    }
  }
}

export function injectGPUDiagnostics() {
  if (typeof window === 'undefined') return

  console.log('[GPU Diagnostics] Started')

  const diagnostics = {
    tileRenders: 0,
    densityChanges: 0,
    lastDensity: 1.0,
    renderTimes: [] as number[],
    densityHistory: [] as DensityHistoryEntry[],
    printReport() {
      console.log('\n=== GPU Diagnostics Report ===')
      console.log(`Total tile renders: ${this.tileRenders}`)
      console.log(`Density changes: ${this.densityChanges}`)

      if (this.renderTimes.length > 0) {
        const avg = this.renderTimes.reduce((a, b) => a + b, 0) / this.renderTimes.length
        const max = Math.max(...this.renderTimes)
        const min = Math.min(...this.renderTimes)
        console.log(`Render times - avg: ${avg.toFixed(2)}ms, min: ${min.toFixed(2)}ms, max: ${max.toFixed(2)}ms`)
      }

      if (this.densityHistory.length > 0) {
        console.log('\nDensity history:')
        this.densityHistory.forEach((entry, i) => {
          console.log(`  #${i + 1}: zoom=${(entry.zoom * 100).toFixed(0)}%, density=${entry.density}`)
        })
      }
    }
  }

  // Monitor tile rendering
  const originalRenderTile = window.__renderTile
  if (originalRenderTile) {
    window.__renderTile = function(...args: unknown[]) {
      const start = performance.now()
      const result = originalRenderTile.apply(this, args)
      const duration = performance.now() - start

      diagnostics.tileRenders++
      diagnostics.renderTimes.push(duration)

      // Log every 10 renders
      if (diagnostics.tileRenders % 10 === 0) {
        const avgTime = diagnostics.renderTimes.slice(-10).reduce((a, b) => a + b, 0) / 10
        console.log(`[Tile Render] Total ${diagnostics.tileRenders}, last 10 avg ${avgTime.toFixed(2)}ms`)
      }

      return result
    }
  }

  // Monitor density changes
  const originalCalculateDensity = window.__calculateDynamicDensity
  if (originalCalculateDensity) {
    window.__calculateDynamicDensity = function(viewport: Viewport) {
      const density = originalCalculateDensity(viewport)

      if (density !== diagnostics.lastDensity) {
        diagnostics.densityChanges++
        diagnostics.lastDensity = density

        console.log(`[Density Change] #${diagnostics.densityChanges}: ${density} (zoom ${(viewport.camera.zoom * 100).toFixed(0)}%)`)

        diagnostics.densityHistory.push({
          time: Date.now(),
          zoom: viewport.camera.zoom,
          density
        })
      }

      return density
    }
  }

  // Expose diagnostics globally
  window.__gpuDiagnostics = diagnostics

  // Auto print report every minute
  setInterval(() => {
    if (diagnostics.tileRenders > 0 || diagnostics.densityChanges > 0) {
      diagnostics.printReport()
    }
  }, 60000)

  console.log('[GPU Diagnostics] To get report, run: window.__gpuDiagnostics.printReport()')
}
