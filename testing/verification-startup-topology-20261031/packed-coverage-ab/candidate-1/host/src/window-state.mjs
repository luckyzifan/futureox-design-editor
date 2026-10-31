import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const finite = value => Number.isFinite(value) && Math.abs(value) <= 1_000_000
const rect = value => value && [value.x, value.y, value.width, value.height].every(finite) && value.width > 0 && value.height > 0
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/** Fit a saved normal rectangle to a currently connected display in CSS pixels. */
export function fitWindowState(saved, displays, primary) {
  const areas = displays.map(display => display.workArea).filter(rect)
  const fallback = rect(primary?.workArea) ? primary.workArea : areas[0] || { x: 0, y: 0, width: 1440, height: 940 }
  const valid = saved?.version === 1 && rect(saved.bounds)
  const wanted = valid ? saved.bounds : { x: fallback.x, y: fallback.y, width: 1440, height: 940 }
  const match = areas.reduce((best, area) => overlap(wanted, area) > overlap(wanted, best) ? area : best, fallback)
  const area = overlap(wanted, match) > 0 ? match : fallback
  const minWidth = Math.min(1000, Math.floor(area.width)), minHeight = Math.min(640, Math.floor(area.height))
  const width = Math.max(minWidth, Math.min(Math.round(wanted.width), Math.floor(area.width)))
  const height = Math.max(minHeight, Math.min(Math.round(wanted.height), Math.floor(area.height)))
  const x = valid ? Math.round(Math.min(Math.max(wanted.x, area.x), area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2)
  const y = valid ? Math.round(Math.min(Math.max(wanted.y, area.y), area.y + area.height - height)) : Math.round(area.y + (area.height - height) / 2)
  return { version: 1, bounds: { x, y, width, height }, minWidth, minHeight,
    maximized: valid && saved.maximized === true, fullscreen: valid && saved.fullscreen === true }
}

/** Apply live display/DPI constraints without overwriting maximized/fullscreen
 * normal bounds. Call again on restore, when changing bounds is safe. */
export function constrainWindowToDisplays(window, displays, primary, { fitBounds = true } = {}) {
  if (!window || window.isDestroyed()) return
  const maximized = window.isMaximized(), fullscreen = window.isFullScreen()
  const fitted = fitWindowState({ version: 1, bounds: window.getNormalBounds(), maximized, fullscreen }, displays, primary)
  const [width, height] = window.getMinimumSize()
  // Lower old minimums before fitting to a smaller DIP work area.
  if (width !== fitted.minWidth || height !== fitted.minHeight) window.setMinimumSize(fitted.minWidth, fitted.minHeight)
  if (fitBounds && !maximized && !fullscreen && JSON.stringify(window.getNormalBounds()) !== JSON.stringify(fitted.bounds)) window.setBounds(fitted.bounds)
  return fitted
}

export async function readWindowState(filename) {
  let file
  try {
    file = await open(filename, 'r')
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4096) throw new Error('Window preferences exceed their supported size')
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096) throw new Error('Window preferences grew beyond their supported size')
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (value?.version !== 1 || !rect(value.bounds)) throw new Error('Window preferences are invalid')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally { await file?.close() }
}

export async function writeWindowState(filename, state) {
  if (state?.version !== 1 || !rect(state.bounds)) throw new Error('Invalid window state')
  const temporary = `${filename}.${randomUUID()}.tmp`
  let file, created = false
  try {
    file = await open(temporary, 'wx', 0o600); created = true
    await file.writeFile(JSON.stringify({ version: 1, bounds: state.bounds, maximized: !!state.maximized, fullscreen: !!state.fullscreen }))
    await file.sync(); await file.close(); file = undefined
    await rename(temporary, filename)
  } finally {
    await file?.close()
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
