import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundled = join(dirname(fileURLToPath(import.meta.url)), '../public/fonts/dejavu')

function readFirst(candidates: string[]): { path: string; bytes: Buffer } {
  for (const path of candidates) {
    if (existsSync(path)) return { path, bytes: readFileSync(path) }
  }
  throw new Error(`Bench font not found. Tried ${candidates.join(', ')}`)
}

/** Repo fonts first, then the Linux package path. Serif falls back to bundled Sans. */
export function benchFonts(): { sans: { path: string; bytes: Buffer }; serif: { path: string; bytes: Buffer } } {
  const sans = readFirst([
    join(bundled, 'DejaVuSans.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ])
  const serif = readFirst([
    join(bundled, 'DejaVuSerif.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    sans.path,
  ])
  return { sans, serif }
}
