import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd(), directory = path.join(root, 'testing/verification-heavy-motion-20261024')
const client = path.join(root, 'frontend/design-client')
const files = [
  'LargeDocumentDialog.editing.test.tsx', 'LargeDocumentDialog.test.tsx', 'LargeDocumentWorkspace.test.tsx',
  'canvas-vector-authority.test.tsx', 'component-override-fields.test.ts', 'document-baseline-certificate.test.ts',
  'document-patch.test.ts', 'import-file-worker.test.ts', 'import-worker-file-read.test.ts', 'import-input-policy.test.ts',
  'local-revisions.test.ts', 'local-store-revision-list.test.ts', 'resident-document-encoder.test.ts', 'vector-geometry.test.ts',
  'number-field-session-boundaries.test.tsx', 'source-scene-patch.test.ts',
  'kernel/interaction-layers.test.ts', 'kernel/native-navigation-surface.test.tsx', 'kernel/native-tile-motion-scale.test.ts',
  'kernel/overview-coverage.test.ts', 'kernel/prepared-tile-fallback.test.ts', 'kernel/progressive-quality.test.ts',
  'kernel/tile-admission.test.ts', 'kernel/tile-cache.test.ts', 'kernel/tile-cache-boundaries.test.ts',
  'kernel/tile-coverage-sweep.test.ts', 'kernel/scene-image-hydration.test.ts',
  'kernel/gpu/fresh-initialize-controls.test.ts', 'kernel/gpu/fresh-initialize-create-gap.test.ts',
  'kernel/gpu/fresh-initialize-held-fence.test.ts', 'kernel/gpu/image-asset-residency.test.ts',
  'kernel/gpu/gpu-resource-boundary.test.ts', 'kernel/gpu/reclaim-maintenance.test.ts',
  'kernel/gpu/painter-stage.test.ts', 'kernel/gpu/scene-packet.test.ts',
].map(file => 'src/' + file)
const commands = [
  { name: 'client-regressions-6', cwd: client, command: 'bunx', args: ['vitest', 'run', '--maxWorkers=2', ...files] },
  { name: 'maintenance-regressions-6', cwd: client, command: process.execPath, args: ['--test', 'src/kernel/gpu/maintenance-residency.test.mjs'] },
  { name: 'host-regressions-6', cwd: path.join(root, 'frontend/design-desktop'), command: process.execPath,
    args: ['--test', 'test/large-document.test.mjs', 'test/sidecar.test.mjs', 'src/resident-document-codec.test.mjs'] },
]
const results = []
for (const item of commands) {
  const log = createWriteStream(path.join(directory, item.name + '.log')), startedAt = Date.now()
  const child = spawn(item.command, item.args, { cwd: item.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const code = await new Promise(resolve => child.on('exit', resolve))
  await new Promise(resolve => log.end(resolve))
  results.push({ ...item, startedAt, endedAt: Date.now(), code })
  await writeFile(path.join(directory, 'regressions-6.json'), JSON.stringify(results, null, 2))
  console.log(item.name, code)
  if (code !== 0) process.exitCode = 1
}
