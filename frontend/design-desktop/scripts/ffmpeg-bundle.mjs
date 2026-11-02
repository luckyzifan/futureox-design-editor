// Copy the vendored FFmpeg for this OS/CPU into dist/bin. The packager already
// publishes dist/bin as an extraResource, which lands at Resources/bin outside
// app.asar. Linux x64 is required; Mac and Windows stay stubs until a binary
// is added under vendor/ffmpeg/<triple>/.
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function ffmpegVendorTriple(platform = process.platform, arch = process.arch) {
  const osName = platform === 'win32' ? 'win32' : platform
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : arch
  return `${osName}-${cpu}`
}

export function ffmpegExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

const LICENSE_COPIES = [
  ['LICENSE.txt', 'ffmpeg-LICENSE.txt'],
  ['COPYING.GPLv3', 'ffmpeg-COPYING.GPLv3'],
  ['COPYING.LGPLv2.1', 'ffmpeg-COPYING.LGPLv2.1'],
  ['source.json', 'ffmpeg-source.json'],
]

export async function installBundledFfmpeg({
  desktop,
  output,
  platform = process.platform,
  arch = process.arch,
}) {
  const triple = ffmpegVendorTriple(platform, arch)
  const exe = ffmpegExecutableName(platform)
  const sourceDir = path.join(desktop, 'vendor/ffmpeg', triple)
  const source = path.join(sourceDir, exe)
  const destDir = path.join(output, 'bin')
  await mkdir(destDir, { recursive: true })
  if (!existsSync(source)) {
    if (platform === 'linux' && arch === 'x64') {
      throw new Error(`Bundled FFmpeg is required at ${source}`)
    }
    return { installed: false, triple, source }
  }
  const dest = path.join(destDir, exe)
  await copyFile(source, dest)
  if (platform !== 'win32') await chmod(dest, 0o755)
  for (const [fromName, toName] of LICENSE_COPIES) {
    const from = path.join(sourceDir, fromName)
    if (existsSync(from)) await copyFile(from, path.join(destDir, toName))
  }
  return { installed: true, triple, dest }
}

export async function assertPackagedFfmpeg({
  platform = process.platform,
  arch = process.arch,
  resourcesBin,
  distBin,
  read = readFile,
}) {
  const exe = ffmpegExecutableName(platform)
  const packagedPath = path.join(resourcesBin, exe)
  const distPath = path.join(distBin, exe)
  const required = platform === 'linux' && arch === 'x64'
  let packaged
  try {
    packaged = await read(packagedPath)
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return { present: false }
    throw new Error(`resources/bin/${exe} must be packaged with the desktop app`)
  }
  const built = await read(distPath)
  if (Buffer.compare(packaged, built) !== 0) {
    throw new Error(`resources/bin/${exe} does not match dist/bin/${exe}`)
  }
  if (platform === 'linux' && packaged.subarray(0, 4).toString('hex') !== '7f454c46') {
    throw new Error('bundled ffmpeg must be an ELF executable')
  }
  if (required) {
    const license = await read(path.join(resourcesBin, 'ffmpeg-LICENSE.txt'))
    const builtLicense = await read(path.join(distBin, 'ffmpeg-LICENSE.txt'))
    if (!license.length || Buffer.compare(license, builtLicense) !== 0) {
      throw new Error('resources/bin/ffmpeg-LICENSE.txt must match the build output')
    }
  }
  return { present: true, bytes: packaged }
}
