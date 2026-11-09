// Check the vendored linux-x64 FFmpeg against source.json.
// A matching hash and banner do not mean the corresponding source was rebuilt.
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

export function ffmpegProvenance({ runBinary = process.platform === 'linux' && process.arch === 'x64' } = {}) {
  const source = JSON.parse(readFileSync(path.join(vendorDir, 'source.json'), 'utf8'))
  const binary = readFileSync(path.join(vendorDir, 'ffmpeg'))
  const readme = readFileSync(path.join(vendorDir, 'UPSTREAM-README.txt'))
  const copying = readFileSync(path.join(vendorDir, 'COPYING.GPLv3'))
  const problems = []
  if (sha256(binary) !== source.sha256) problems.push('ffmpeg sha256 does not match source.json')
  if (binary.length !== source.byteLength) problems.push('ffmpeg length does not match source.json')
  if (sha256(readme) !== source.upstreamReadmeSha256) problems.push('UPSTREAM-README.txt sha256 does not match source.json')
  if (sha256(copying) !== source.copyingGpLv3Sha256) problems.push('COPYING.GPLv3 sha256 does not match source.json')
  if (!copying.includes(Buffer.from('GNU GENERAL PUBLIC LICENSE')) || !copying.includes(Buffer.from('Version 3, 29 June 2007'))) {
    problems.push('COPYING.GPLv3 is not the GPLv3 text')
  }
  if (source.correspondingSourceInRepo !== false || source.rebuiltFromSource !== false) {
    problems.push('source.json must keep corresponding source and rebuild flags false')
  }
  const readmeText = readme.toString('utf8')
  if (!readmeText.includes('build: ffmpeg-7.0.2-amd64-static.tar.xz')) problems.push('upstream readme does not name the 7.0.2 static build')
  if (!readmeText.includes('libx264:') || !readmeText.includes('libvpx:')) problems.push('upstream readme is missing libx264 or libvpx')
  let bannerChecked = false
  if (runBinary) {
    const version = spawnSync(path.join(vendorDir, 'ffmpeg'), ['-version'], { encoding: 'utf8' })
    if (version.status !== 0) problems.push('ffmpeg -version failed')
    const configuration = version.stdout?.match(/^configuration:\s*(.+)$/m)?.[1] ?? ''
    if (configuration !== source.configuration) problems.push('ffmpeg configuration does not match source.json')
    if (!version.stdout?.startsWith('ffmpeg version 7.0.2-static ')) problems.push('ffmpeg banner version is not 7.0.2-static')
    const file = spawnSync('file', [path.join(vendorDir, 'ffmpeg')], { encoding: 'utf8' })
    const buildId = file.stdout?.match(/BuildID\[sha1\]=([0-9a-f]+)/)?.[1] ?? null
    if (buildId !== source.buildId) problems.push('ELF build id does not match source.json')
    bannerChecked = true
  }
  return {
    schema: 1,
    issue: 90,
    classification: 'release_prep',
    confirmedRuntimeFault: false,
    binarySha256: sha256(binary),
    obtainedFrom: source.obtainedFrom,
    obtainedGzSha256: source.obtainedGzSha256,
    correspondingSourceInRepo: false,
    rebuiltFromSource: false,
    releaseSourceIndexContainsThisBuild: source.releaseSourceIndexContainsThisBuild,
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
