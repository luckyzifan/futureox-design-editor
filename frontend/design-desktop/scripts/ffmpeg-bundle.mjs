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

export function requiresBundledFfmpeg(platform, arch) {
  return platform === 'linux' && arch === 'x64'
}

// Packaged names stay beside the binary. The source tarballs are the
// corresponding source for this GPL executable, not optional documentation.
export const FFMPEG_PACKAGE_NOTICES = [
  ['LICENSE.txt', 'ffmpeg-LICENSE.txt'],
  ['BUILD.txt', 'ffmpeg-BUILD.txt'],
  ['rebuild.sh', 'ffmpeg-rebuild.sh'],
  ['COPYING.GPLv2', 'ffmpeg-COPYING.GPLv2'],
  ['COPYING.GPLv3', 'ffmpeg-COPYING.GPLv3'],
  ['COPYING.LGPLv2.1', 'ffmpeg-COPYING.LGPLv2.1'],
  ['COPYING.LGPLv3', 'ffmpeg-COPYING.LGPLv3'],
  ['x264-COPYING', 'ffmpeg-x264-COPYING'],
  ['libvpx-LICENSE', 'ffmpeg-libvpx-LICENSE'],
  ['source.json', 'ffmpeg-source.json'],
  ['sources/ffmpeg-n7.0.2.tar.gz', 'ffmpeg-source-ffmpeg-n7.0.2.tar.gz'],
  ['sources/libvpx-1.15.2.tar.gz', 'ffmpeg-source-libvpx-1.15.2.tar.gz'],
  ['sources/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz', 'ffmpeg-source-x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz'],
]

export const LINUX_NOTICES = FFMPEG_PACKAGE_NOTICES.map(([, packaged]) => packaged)

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
    if (requiresBundledFfmpeg(platform, arch)) {
      throw new Error(`Bundled FFmpeg is required at ${source}`)
    }
    return { installed: false, triple, source }
  }
  const dest = path.join(destDir, exe)
  await copyFile(source, dest)
  if (platform !== 'win32') await chmod(dest, 0o755)
  for (const [fromName, toName] of FFMPEG_PACKAGE_NOTICES) {
    const from = path.join(sourceDir, fromName)
    if (!existsSync(from)) {
      if (requiresBundledFfmpeg(platform, arch)) {
        throw new Error(`Bundled FFmpeg notice is required at ${from}`)
      }
      continue
    }
    const noticeDest = path.join(destDir, toName)
    await copyFile(from, noticeDest)
    if (toName.endsWith('.sh') && platform !== 'win32') await chmod(noticeDest, 0o755)
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
  const required = requiresBundledFfmpeg(platform, arch)
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
    for (const name of LINUX_NOTICES) {
      const packagedNotice = await read(path.join(resourcesBin, name))
      const builtNotice = await read(path.join(distBin, name))
      if (!packagedNotice.length || Buffer.compare(packagedNotice, builtNotice) !== 0) {
        throw new Error(`resources/bin/${name} must match the build output`)
      }
    }
  }
  return { present: true, bytes: packaged }
}
