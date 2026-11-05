// Capture build provenance without claiming byte-reproducibility. Generated bindings,
// WASM and renderer output are artifact hashes, not compiler source inputs.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const BUILD_DIRECTORIES = [
  'frontend/design-desktop/src',
  'frontend/design-mcp/src',
  'frontend/design-desktop/assets',
  'frontend/design-desktop/scripts',
  'frontend/design-client/src',
  'frontend/design-client/public',
  'design-studio/crates/design-kernel/src',
  'design-studio/crates/design-desktop-backend/src',
  'design-studio/crates/design-gpu/src',
  'design-studio/crates/design-kernel/shaders',
  'vendor/moxcms/src',
  'vendor/flo_curves/src',
]
export const BUILD_FILES = [
  'frontend/design-client/bun.lock',
  'frontend/design-desktop/bun.lock',
  'frontend/design-client/package.json',
  'frontend/design-client/vite.config.ts',
  'frontend/design-client/scripts/production-public.mjs',
  'THIRD_PARTY_NOTICES.md',
  'frontend/design-client/tsconfig.json',
  'frontend/design-client/index.html',
  'frontend/design-desktop/package.json',
  'docs/ELECTRON_LOCAL_MCP.zh-CN.md',
  'design-studio/Cargo.toml',
  'design-studio/Cargo.lock',
  'design-studio/crates/design-kernel/Cargo.toml',
  'design-studio/crates/design-desktop-backend/Cargo.toml',
  'design-studio/crates/design-gpu/Cargo.toml',
  'design-studio/scripts/build-web.py',
  'rust-toolchain.toml',
  '.cargo/config.toml',
  'vendor/moxcms/Cargo.toml',
  'vendor/flo_curves/Cargo.toml',
  'vendor/flo_curves/LICENSE',
  'vendor/flo_curves/PATCHES.md',
  'frontend/design-desktop/vendor/ffmpeg/README.md',
  'frontend/design-desktop/vendor/ffmpeg/linux-x64/ffmpeg',
  'frontend/design-desktop/vendor/ffmpeg/linux-x64/LICENSE.txt',
  'frontend/design-desktop/vendor/ffmpeg/linux-x64/COPYING.GPLv3',
  'frontend/design-desktop/vendor/ffmpeg/linux-x64/COPYING.LGPLv2.1',
  'frontend/design-desktop/vendor/ffmpeg/linux-x64/source.json',
  'frontend/design-desktop/vendor/ffmpeg/darwin-arm64/README.md',
  'frontend/design-desktop/vendor/ffmpeg/darwin-x64/README.md',
  'frontend/design-desktop/vendor/ffmpeg/win32-x64/README.md',
]

export function buildProfile(args) {
  const chosen = ['--debug', '--fast', '--release'].filter((flag) => args.includes(flag))
  if (chosen.length > 1) throw Error(`Choose one of --debug, --fast or --release (got ${chosen.join(' + ')})`)
  if (chosen[0] === '--debug') return 'debug'
  if (chosen[0] === '--fast') return 'desktop-dev'
  return 'release'
}

/** Explicit isolated build output must be fresh: Vite empties renderer/. */
export async function buildOutput(desktop, args) {
  const selected = args.filter(arg => arg.startsWith('--out-dir='))
  if (selected.length > 1 || selected[0] === '--out-dir=') throw Error('Choose one nonempty --out-dir=PATH')
  if (!selected.length) return path.join(desktop, 'dist')
  const output = path.resolve(selected[0].slice('--out-dir='.length))
  await mkdir(output) // Existing directories, including symlinks, reject.
  return output
}

export async function buildInputs(core) {
  const result = {}
  async function visit(relative) {
    if (
      relative === 'frontend/design-client/src/generated' ||
      relative === 'frontend/design-client/public/kernel'
    )
      return
    const entries = await readdir(path.join(core, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile()) await add(name)
      else throw new Error(`Unexpected build input: ${name}`)
    }
  }
  async function add(name) {
    result[name] = createHash('sha256')
      .update(await readFile(path.join(core, name)))
      .digest('hex')
  }
  for (const directory of BUILD_DIRECTORIES) await visit(directory)
  for (const name of BUILD_FILES) await add(name)
  return result
}
