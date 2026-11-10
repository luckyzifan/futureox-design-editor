// Check the vendored linux-x64 FFmpeg against the sources that built it.
// The binary, rebuild script, source tarballs, license texts, and banner
// must describe one build. Spawning this program does not license the app.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = path.join(desktop, 'vendor/ffmpeg/linux-x64')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readVendor(relative) {
  return readFileSync(path.join(vendorDir, relative))
}

export function ffmpegProvenance({ runBinary = process.platform === 'linux' && process.arch === 'x64' } = {}) {
  const source = JSON.parse(readFileSync(path.join(vendorDir, 'source.json'), 'utf8'))
  const problems = []
  const binary = readVendor('ffmpeg')
  if (sha256(binary) !== source.sha256) problems.push('ffmpeg sha256 does not match source.json')
  if (binary.length !== source.byteLength) problems.push('ffmpeg length does not match source.json')
  if (source.correspondingSourceInRepo !== true) problems.push('corresponding source must be in the repository')
  if (source.rebuiltFromSource !== true) problems.push('source.json must record that this binary was rebuilt')
  if (source.license !== 'GPL-3.0-or-later') problems.push('bundled ffmpeg license must stay GPL-3.0-or-later')
  if (!Array.isArray(source.sources) || source.sources.length !== 3) problems.push('source.json must list ffmpeg, libvpx, and x264')
  for (const item of source.sources ?? []) {
    const bytes = readVendor(item.file)
    if (sha256(bytes) !== item.sha256) problems.push(`${item.file} sha256 does not match source.json`)
    if (!item.obtainedFrom || !item.version) problems.push(`${item.file} is missing its origin or version`)
  }
  const script = readVendor('rebuild.sh')
  if (sha256(script) !== source.rebuildScriptSha256) problems.push('rebuild.sh sha256 does not match source.json')
  const scriptText = script.toString('utf8')
  for (const flag of ['--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-libvpx', '--enable-static']) {
    if (!scriptText.includes(flag)) problems.push(`rebuild.sh is missing ${flag}`)
  }
  for (const item of source.sources ?? []) {
    if (!scriptText.includes(path.basename(item.file))) problems.push(`rebuild.sh does not name ${item.file}`)
  }
  const buildRecord = readVendor('BUILD.txt').toString('utf8')
  if (sha256(buildRecord) !== source.buildRecordSha256) problems.push('BUILD.txt sha256 does not match source.json')
  if (!buildRecord.includes('n7.0.2') || !buildRecord.includes('libvpx 1.15.2') || !buildRecord.includes('b35605ace3ddf7c1a5d67a2eb553f034aef41d55')) {
    problems.push('BUILD.txt does not name the pinned FFmpeg, libvpx, and x264 revisions')
  }
  for (const notice of source.notices ?? []) {
    const bytes = readVendor(notice.file)
    if (sha256(bytes) !== notice.sha256) problems.push(`${notice.file} sha256 does not match source.json`)
  }
  const gpl3 = readVendor('COPYING.GPLv3')
  if (!gpl3.includes(Buffer.from('GNU GENERAL PUBLIC LICENSE')) || !gpl3.includes(Buffer.from('Version 3, 29 June 2007'))) {
    problems.push('COPYING.GPLv3 is not the GPLv3 text')
  }
  const x264 = readVendor('x264-COPYING').toString('utf8')
  if (!x264.includes('GNU GENERAL PUBLIC LICENSE') || !x264.includes('Version 2')) problems.push('x264-COPYING is not the x264 GPL text')
  if (!readVendor('libvpx-LICENSE').includes(Buffer.from('Copyright'))) problems.push('libvpx-LICENSE is empty')
  let bannerChecked = false
  if (runBinary) {
    const version = spawnSync(path.join(vendorDir, 'ffmpeg'), ['-version'], { encoding: 'utf8' })
    if (version.status !== 0) problems.push('ffmpeg -version failed')
    const configuration = version.stdout?.match(/^configuration:\s*(.+)$/m)?.[1] ?? ''
    if (configuration !== source.configuration) problems.push('ffmpeg configuration does not match source.json')
    if (!version.stdout?.startsWith(source.bannerPrefix)) problems.push('ffmpeg banner does not match source.json')
    for (const flag of ['--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-libvpx']) {
      if (!configuration.includes(flag)) problems.push(`ffmpeg banner is missing ${flag}`)
    }
    const file = spawnSync('file', [path.join(vendorDir, 'ffmpeg')], { encoding: 'utf8' })
    const buildId = file.stdout?.match(/BuildID\[sha1\]=([0-9a-f]+)/)?.[1] ?? null
    if (buildId !== source.buildId) problems.push('ELF build id does not match source.json')
    const ldd = spawnSync('ldd', [path.join(vendorDir, 'ffmpeg')], { encoding: 'utf8' })
    if (ldd.status !== 0) problems.push('ldd failed')
    if (/libx264|libvpx/.test(ldd.stdout ?? '')) problems.push('libx264 or libvpx is dynamically linked')
    for (const soname of source.dynamicSonames ?? []) {
      if (!(ldd.stdout ?? '').includes(soname)) problems.push(`dynamic dependency ${soname} is missing`)
    }
    bannerChecked = true
  }
  return {
    schema: 2,
    issue: 90,
    classification: 'corresponding_source',
    confirmedRuntimeFault: false,
    binarySha256: sha256(binary),
    correspondingSourceInRepo: source.correspondingSourceInRepo === true,
    rebuiltFromSource: source.rebuiltFromSource === true,
    sources: (source.sources ?? []).map(item => ({ name: item.name, version: item.version, sha256: item.sha256 })),
    independentProcess: true,
    wholeApplicationLicense: 'not decided from the FFmpeg spawn path',
    bannerChecked,
    problems,
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = ffmpegProvenance()
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.problems.length ? 1 : 0)
}
