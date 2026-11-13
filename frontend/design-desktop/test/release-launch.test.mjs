import { realpathSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acceptanceProfileArgument, launchFilesFromArgv, resolveAcceptanceProfile, selectDesktopProfile } from '../src/release-launch.mjs'

test('linux launch argv keeps absolute fd files and drops flags and relative paths', () => {
  const files = launchFilesFromArgv([
    '/usr/bin/futureox-desgin',
    '--core-cpu-only',
    '--desktop-acceptance-profile=/tmp/profile',
    'relative.fd',
    '/tmp/original.fd',
    '/tmp/notes.txt',
    '/tmp/second.fd',
  ], 'linux')
  assert.deepEqual(files, ['/tmp/original.fd', '/tmp/second.fd'])
  assert.deepEqual(launchFilesFromArgv(['/tmp/original.fd'], 'darwin'), [])
  assert.deepEqual(launchFilesFromArgv(['/tmp/original.fd'], 'win32'), ['/tmp/original.fd'])
})

test('acceptance profile must be one real private directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-acceptance-profile-'))
  try {
    const profile = path.join(root, 'profile')
    const home = path.join(root, 'home')
    const userData = path.join(home, '.config', 'futureox-desgin')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    await mkdir(userData, { recursive: true, mode: 0o700 })
    const resolved = resolveAcceptanceProfile(
      [`--desktop-acceptance-profile=${profile}`],
      { defaultUserData: userData, home },
    )
    assert.equal(resolved, realpathSync(profile))
    assert.equal(resolveAcceptanceProfile([], { env: { FUTUREOX_ACCEPTANCE_PROFILE: profile }, defaultUserData: userData, home }), realpathSync(profile))
    assert.throws(() => acceptanceProfileArgument([`--desktop-acceptance-profile=${profile}`], { FUTUREOX_ACCEPTANCE_PROFILE: profile }), /only one/)
    assert.throws(() => resolveAcceptanceProfile(['--desktop-acceptance-profile=relative'], { defaultUserData: userData, home }), /absolute/)
    assert.throws(() => resolveAcceptanceProfile([`--desktop-acceptance-profile=${userData}`], { defaultUserData: userData, home }), /default user data/)
    assert.throws(() => resolveAcceptanceProfile([`--desktop-acceptance-profile=${home}`], { defaultUserData: userData, home }), /home directory/)
    await chmod(profile, 0o777)
    assert.throws(() => resolveAcceptanceProfile([`--desktop-acceptance-profile=${profile}`], { defaultUserData: userData, home }), /world-writable/)
    await chmod(profile, 0o700)
    const link = path.join(root, 'link')
    await symlink(profile, link)
    assert.throws(() => resolveAcceptanceProfile([`--desktop-acceptance-profile=${link}`], { defaultUserData: userData, home }), /real directory/)
    assert.equal(selectDesktopProfile({ acceptanceProfile: resolved }).profile, realpathSync(profile))
    assert.throws(() => selectDesktopProfile({ acceptanceProfile: profile, smoke: true }), /cannot be combined/)
    let created = 0
    const temporary = selectDesktopProfile({ guiTest: true, createTemporary: () => { created += 1; return path.join(root, 'temp') } })
    assert.equal(created, 1)
    assert.equal(temporary.source, 'temporary')
    await writeFile(path.join(root, 'not-a-directory'), 'x')
    assert.throws(() => resolveAcceptanceProfile([`--desktop-acceptance-profile=${path.join(root, 'not-a-directory')}`], { defaultUserData: userData, home }), /real directory/)
  } finally {
    await chmod(path.join(root, 'profile'), 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
