// Host launch policy for a packaged acceptance profile and for opening .fd
// paths that Linux/Windows put on argv. The renderer never chooses these paths.
import path from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'

const PROFILE_FLAG = '--desktop-acceptance-profile='

export function launchFilesFromArgv(argv, platform) {
  if (platform === 'darwin' || !Array.isArray(argv)) return []
  const files = []
  for (const value of argv) {
    if (typeof value !== 'string' || value.startsWith('-')) continue
    if (value.length > 32 * 1024 || value.includes('\0')) continue
    if (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.fd') continue
    files.push(value)
  }
  return files
}

export function acceptanceProfileArgument(argv = [], env = {}) {
  const flags = Array.isArray(argv)
    ? argv.filter(value => typeof value === 'string' && value.startsWith(PROFILE_FLAG))
    : []
  const fromEnv = typeof env.FUTUREOX_ACCEPTANCE_PROFILE === 'string' ? env.FUTUREOX_ACCEPTANCE_PROFILE : ''
  if (flags.length > 1) throw new Error('--desktop-acceptance-profile must occur once')
  if (flags.length && fromEnv) throw new Error('Pass the acceptance profile with only one of --desktop-acceptance-profile and FUTUREOX_ACCEPTANCE_PROFILE')
  const raw = flags.length ? flags[0].slice(PROFILE_FLAG.length) : fromEnv
  if (!raw) return null
  if (!path.isAbsolute(raw) || raw.includes('\0')) throw new Error('--desktop-acceptance-profile must be an absolute path')
  return raw
}

export function resolveAcceptanceProfile(argv, { defaultUserData, home, env = {}, lstat = lstatSync, realpath = realpathSync } = {}) {
  const raw = acceptanceProfileArgument(argv, env)
  if (!raw) return null
  let info
  try {
    info = lstat(raw)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('--desktop-acceptance-profile directory is missing')
    throw error
  }
  if (typeof info.isDirectory !== 'function' || !info.isDirectory() || info.isSymbolicLink?.()) {
    throw new Error('--desktop-acceptance-profile must be a real directory')
  }
  if ((info.mode & 0o002) !== 0) throw new Error('--desktop-acceptance-profile must not be world-writable')
  const resolved = realpath(raw)
  if (typeof defaultUserData === 'string' && defaultUserData && (resolved === defaultUserData || resolved.startsWith(defaultUserData + path.sep))) {
    throw new Error('--desktop-acceptance-profile must not be the default user data directory')
  }
  if (typeof home === 'string' && home && resolved === home) throw new Error('--desktop-acceptance-profile must not be the home directory')
  return resolved
}

export function selectDesktopProfile({ smoke = false, guiTest = false, isolatedProfile = false, acceptanceProfile = null, createTemporary } = {}) {
  if (acceptanceProfile && (smoke || guiTest || isolatedProfile)) {
    throw new Error('--desktop-acceptance-profile cannot be combined with --desktop-smoke, --desktop-gui-test, or --desktop-isolated-profile')
  }
  if (!(smoke || guiTest || isolatedProfile || acceptanceProfile)) return null
  if (acceptanceProfile) return { isolated: true, profile: acceptanceProfile, source: 'acceptance-profile' }
  if (typeof createTemporary !== 'function') throw new Error('temporary profile directory is unavailable')
  return { isolated: true, profile: createTemporary(), source: 'temporary' }
}
