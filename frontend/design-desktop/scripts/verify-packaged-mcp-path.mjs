// Build a same-target Electron bundle and run the packaged MCP entries.
// External AI clients are recorded, not launched. Tokens are not printed.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageMcp } from './mcp-bundle.mjs'
import { verifyPackagedMcpTransport } from '../test/runtime/packaged-mcp-transport.mjs'
import { probeExternalClients } from '../test/runtime/external-mcp-clients.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(desktop, '../..')
const require = createRequire(path.join(desktop, 'package.json'))

function findElectronZip(version) {
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`
  const roots = [process.env.ELECTRON_CACHE, path.join(process.env.HOME ?? '', '.cache/electron'), path.join(process.env.LOCALAPPDATA ?? '', 'electron/Cache')].filter(Boolean)
  for (const root of roots) {
    if (!existsSync(root)) continue
    const queue = [{ dir: root, depth: 0 }]
    while (queue.length) {
      const { dir, depth } = queue.pop()
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isFile() && entry.name === name) return { dir, name }
        if (entry.isDirectory() && depth < 2) queue.push({ dir: full, depth: depth + 1 })
      }
    }
  }
  return null
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifySameTargetPackagedMcp() {
  const metadata = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'))
  const version = metadata.devDependencies.electron
  let packager
  try { ({ packager } = await import('@electron/packager')) }
  catch (error) { throw new Error('Install frontend/design-desktop dependencies before package-path verification (' + error.message + ')') }
  const electronDir = path.dirname(require.resolve('electron/package.json'))
  const checksums = JSON.parse(await readFile(path.join(electronDir, 'checksums.json'), 'utf8'))
  const zip = findElectronZip(version)
  let electronZipDir
  if (zip) {
    const expected = checksums[zip.name]
    if (typeof expected !== 'string') throw new Error('Electron checksum is unavailable for ' + zip.name)
    const actual = await sha256(path.join(zip.dir, zip.name))
    if (actual !== expected) throw new Error('Electron ZIP checksum mismatch: ' + zip.name)
    electronZipDir = zip.dir
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'fx-mcp-package-'))
  try {
    const staging = path.join(temp, 'app')
    const mcp = path.join(temp, 'design-mcp')
    await mkdir(path.join(staging, 'src'), { recursive: true })
    await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'futureox-desgin', productName: 'futureox-desgin', version: metadata.version, private: true, main: 'src/main.mjs' }))
    await writeFile(path.join(staging, 'src/main.mjs'), 'process.exit(0)\n')
    for (const name of ['automation-bridge.mjs', 'figma-mcp-host.mjs', 'workspace-automation.mjs']) {
      await cp(path.join(desktop, 'src', name), path.join(staging, 'src', name))
    }
    await stageMcp(core, mcp)
    const outputs = await packager({
      dir: staging, name: 'futureox-desgin', executableName: 'futureox-desgin',
      platform: process.platform, arch: process.arch, electronVersion: version, electronZipDir,
      out: path.join(temp, 'out'), overwrite: true, asar: true, prune: false, extraResource: [mcp], quiet: true,
    })
    const bundle = outputs[0]
    const executable = process.platform === 'darwin'
      ? path.join(bundle, 'futureox-desgin.app/Contents/MacOS/futureox-desgin')
      : path.join(bundle, process.platform === 'win32' ? 'futureox-desgin.exe' : 'futureox-desgin')
    const resources = process.platform === 'darwin'
      ? path.join(bundle, 'futureox-desgin.app/Contents/Resources')
      : path.join(bundle, 'resources')
    const asar = await import('@electron/asar')
    const extracted = path.join(temp, 'asar')
    asar.extractAll(path.join(resources, 'app.asar'), extracted)
    const transport = await verifyPackagedMcpTransport({ resources, executable, hostSource: extracted, cwd: temp })
    const clients = probeExternalClients().map(client => ({ id: client.id, title: client.title, status: client.status, evidence: client.evidence }))
    const report = {
      ...transport,
      sameTarget: true,
      platform: process.platform,
      arch: process.arch,
      bundleKind: 'unsigned_packager_output',
      externalClientAcceptance: false,
      editorGui: 'not_run',
      signedInstaller: 'not_run',
      clients,
      externalClientSteps: ['handshake', 'read', 'edit', 'screenshot', 'undo', 'revoke_rejects_old_resource'].map(id => ({ id, status: 'not_run', scope: 'external_client' })),
      blocked: 'Claude Code, Codex, Kimi Code CLI, Kimi CLI 1.x, and DeepSeek Harness were not started. figma-cli.mjs has no history.undo tool; the packaged cli.mjs undoes that edit on the same bridge. This is not the product Editor GUI or a signed installer.',
    }
    if (clients.some(client => client.status === 'passed')) throw new Error('External client probe must not report passed without a live session')
    if (JSON.stringify(report).includes('FUTUREOX_DESIGN_BRIDGE_TOKEN')) throw new Error('Package-path report included a credential field')
    return report
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  verifySameTargetPackagedMcp().then(report => {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  }).catch(error => {
    process.stderr.write((error?.stack || error?.message || String(error)) + '\n')
    process.exitCode = 1
  })
}
