import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertProductName,
  bundleLaunchContract,
  installedBundleFromListing,
  workspaceSelectionSeed,
} from '../scripts/release-deb-install.mjs'
import { describePackage } from '../scripts/release-package-resources.mjs'
import { planReleaseLaunch } from '../scripts/release-session-report.mjs'

const LISTING = `
drwxr-xr-x root/root         0 2026-11-12 08:25 ./opt/futureox-desgin/
-rwxr-xr-x root/root 228605256 2026-11-12 08:25 ./opt/futureox-desgin/futureox-desgin
drwxr-xr-x root/root         0 2026-11-12 08:25 ./opt/futureox-desgin/resources/
-rw-r--r-- root/root  94327267 2026-11-12 08:25 ./opt/futureox-desgin/resources/app.asar
lrwxrwxrwx root/root         0 2026-11-12 08:37 ./usr/bin/futureox-desgin -> /opt/futureox-desgin/futureox-desgin
`

test('a deb listing resolves the bundle and ignores the usr/bin symlink', () => {
  const bundle = installedBundleFromListing(LISTING)
  assert.deepEqual(bundle, {
    directory: 'opt/futureox-desgin',
    executable: 'opt/futureox-desgin/futureox-desgin',
    resources: 'opt/futureox-desgin/resources',
  })
  assert.equal(installedBundleFromListing('-rwxr-xr-x root/root 1 2026-11-12 08:25 ./futureox-desgin\n'), null)
})

test('launch contract follows the packaged host source', () => {
  assert.deepEqual(bundleLaunchContract('no hooks'), { acceptanceProfile: false, argvFiles: false })
  assert.deepEqual(bundleLaunchContract('launchFilesFromArgv FUTUREOX_ACCEPTANCE_PROFILE'), {
    acceptanceProfile: true,
    argvFiles: true,
  })
  assert.equal(JSON.parse(workspaceSelectionSeed()).kind, 'default')
  assert.throws(() => assertProductName('../futureox'), /product name/)
})

test('hashing a deb still does not make it a launchable bundle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-deb-plan-'))
  try {
    const deb = path.join(root, 'futureox-design.deb')
    await writeFile(deb, 'not-a-real-deb')
    const plan = planReleaseLaunch(describePackage(deb, { platform: 'linux', arch: 'x64' }), { platform: 'linux', arch: 'x64' })
    assert.equal(plan.canLaunch, false)
    assert.equal(plan.blockers.includes('installer_not_opened'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
