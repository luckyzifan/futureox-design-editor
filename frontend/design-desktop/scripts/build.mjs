import assert from 'node:assert/strict'
import { buildInputs, buildOutput, buildProfile } from './build-inputs.mjs'
import { installSidecar } from './install-sidecar.mjs'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(desktop, '../..')
const design = path.join(core, 'design-studio')
const output = await buildOutput(desktop, process.argv.slice(2))
const profile = buildProfile(process.argv.slice(2))
// Explicit native-only candidate. WASM/editor semantics keep their normal
// build; the source wire format remains behind its runtime publication switch.
const nativeFeatures = process.argv.includes('--mapped-source-snapshot')
  ? ['futureox-design-kernel/mapped-source-snapshot', 'futureox-design-desktop-backend/mapped-source-snapshot'] : []
const bun = process.env.BUN_EXECUTABLE || 'bun'
const inputs = await buildInputs(core)
function run(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`${command} failed (${child.status ?? child.signal})`)
}
// Build the existing React client and its real Rust/WASM kernel, not a second renderer.
run(bun, ['run', 'build:kernel'], path.join(core, 'frontend/design-client'))
run(bun, ['run', 'typecheck'], path.join(core, 'frontend/design-client'))
run(
  bun,
  [
    'run',
    'vite',
    'build',
    '--base',
    './',
    '--outDir',
    path.join(output, 'renderer'),
    '--emptyOutDir',
  ],
  path.join(core, 'frontend/design-client'),
)
// 'debug' needs no flag (cargo dev profile); 'desktop-dev' and 'release' are
// selected explicitly. Artifacts land in target/<profile>/ for all three.
const cargoProfileFlags =
  profile === 'release'
    ? ['--release']
    : profile === 'desktop-dev'
      ? ['--profile', 'desktop-dev']
      : []
run(
  'cargo',
  [
    'build',
    '--locked',
    '--manifest-path',
    path.join(design, 'Cargo.toml'),
    '-p',
    'futureox-design-desktop-backend',
    '-p',
    'futureox-design-gpu',
    '-p',
    'futureox-design-kernel',
    ...cargoProfileFlags,
    ...(nativeFeatures.length ? ['--features', nativeFeatures.join(',')] : []),
  ],
  design,
)
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(design, process.env.CARGO_TARGET_DIR)
  : path.join(design, 'target')
const binary = `futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`
await mkdir(path.join(output, 'sidecar'), { recursive: true })
await installSidecar(path.join(target, profile, binary), path.join(output, 'sidecar', binary))
// Native render loop (item ④): the design-render serve-mode binary and the
// CJK text font land where the main process resolves them (dist in dev,
// process.resourcesPath when packaged — see src/native-render.mjs).
// Both native products share one Cargo graph above, avoiding a second kernel
// build with a different union of dependency features. --debug is explicit.
const renderBinary = `design-render${process.platform === 'win32' ? '.exe' : ''}`
await mkdir(path.join(output, 'bin'), { recursive: true })
await installSidecar(path.join(target, profile, renderBinary), path.join(output, 'bin', renderBinary))
const prepareBinary = `design-prepare${process.platform === 'win32' ? '.exe' : ''}`
await installSidecar(path.join(target, profile, prepareBinary), path.join(output, 'bin', prepareBinary))
const font = path.join(core, 'frontend/design-client/public/fonts/NotoSansSC.ttf')
await mkdir(path.join(output, 'fonts'), { recursive: true })
await copyFile(font, path.join(output, 'fonts', 'NotoSansSC.ttf'))
for (const notice of ['OFL.txt', 'source.json']) {
  await copyFile(path.join(path.dirname(font), notice), path.join(output, 'fonts', notice))
}
console.log(
  `Built ${process.platform}/${process.arch} desktop renderer and Rust sidecar in ${output}`,
)

assert.deepEqual(
  await buildInputs(core),
  inputs,
  'Source changed during desktop build; rebuild before packaging',
)
await writeFile(
  path.join(output, 'build-manifest.json'),
  `${JSON.stringify(
    {
      format: 1,
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      profile,
      nativeFeatures,
      sources: inputs,
    },
    null,
    2,
  )}\n`,
)
