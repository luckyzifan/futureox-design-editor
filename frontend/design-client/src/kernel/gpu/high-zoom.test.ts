import { test } from 'vitest'
import { GpuRenderer } from './renderer'
import { highZoomRegressions } from './renderer-regression-cases'

// Executes the real renderer graph with an allocation/command-recording driver.
// GPU edge pixels still require the separate browser/Electron visual checks.
highZoomRegressions(test, GpuRenderer)
