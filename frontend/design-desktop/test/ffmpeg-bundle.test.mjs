import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertPackagedFfmpeg, ffmpegExecutableName, ffmpegVendorTriple, installBundledFfmpeg } from '../scripts/ffmpeg-bundle.mjs'

test('vendor triples name the packaged executable', () => {
  assert.equal(ffmpegVendorTriple('linux', 'x64'), 'linux-x64')
  assert.equal(ffmpegVendorTriple('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(ffmpegVendorTriple('win32', 'x64'), 'win32-x64')
  assert.equal(ffmpegExecutableName('win32'), 'ffmpeg.exe')
  assert.equal(ffmpegExecutableName('linux'), 'ffmpeg')
})

test('install copies a vendored binary and linux x64 is required', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-ffmpeg-install-'))
  try {
    const desktop = path.join(root, 'desktop')
    const output = path.join(root, 'dist')
    await mkdir(path.join(desktop, 'vendor/ffmpeg/linux-x64'), { recursive: true })
    await writeFile(path.join(desktop, 'vendor/ffmpeg/linux-x64/ffmpeg'), 'elf-bytes')
    await chmod(path.join(desktop, 'vendor/ffmpeg/linux-x64/ffmpeg'), 0o755)
    await writeFile(path.join(desktop, 'vendor/ffmpeg/linux-x64/LICENSE.txt'), 'gpl notice')
    await writeFile(path.join(desktop, 'vendor/ffmpeg/linux-x64/UPSTREAM-README.txt'), 'upstream readme')
    const installed = await installBundledFfmpeg({ desktop, output, platform: 'linux', arch: 'x64' })
    assert.equal(installed.installed, true)
    assert.equal(await readFile(installed.dest, 'utf8'), 'elf-bytes')
    assert.equal((await stat(installed.dest)).mode & 0o111, 0o111)
    assert.equal(await readFile(path.join(output, 'bin/ffmpeg-LICENSE.txt'), 'utf8'), 'gpl notice')
    assert.equal(await readFile(path.join(output, 'bin/ffmpeg-UPSTREAM-README.txt'), 'utf8'), 'upstream readme')
    const missing = path.join(root, 'empty-desktop')
    await mkdir(missing, { recursive: true })
    await assert.rejects(
      installBundledFfmpeg({ desktop: missing, output: path.join(root, 'empty-out'), platform: 'linux', arch: 'x64' }),
      /required/,
    )
    const skipped = await installBundledFfmpeg({
      desktop: missing,
      output: path.join(root, 'mac-out'),
      platform: 'darwin',
      arch: 'arm64',
    })
    assert.equal(skipped.installed, false)
    assert.equal(skipped.triple, 'darwin-arm64')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('package verification requires the linux binary and license to match dist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fx-ffmpeg-verify-'))
  try {
    const resourcesBin = path.join(root, 'resources/bin')
    const distBin = path.join(root, 'dist/bin')
    await mkdir(resourcesBin, { recursive: true })
    await mkdir(distBin, { recursive: true })
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('ffmpeg')])
    await writeFile(path.join(resourcesBin, 'ffmpeg'), elf)
    await writeFile(path.join(distBin, 'ffmpeg'), elf)
    for (const name of ['ffmpeg-LICENSE.txt', 'ffmpeg-COPYING.GPLv3', 'ffmpeg-COPYING.LGPLv2.1', 'ffmpeg-source.json', 'ffmpeg-UPSTREAM-README.txt']) {
      await writeFile(path.join(resourcesBin, name), `notice:${name}`)
      await writeFile(path.join(distBin, name), `notice:${name}`)
    }
    const ok = await assertPackagedFfmpeg({ platform: 'linux', arch: 'x64', resourcesBin, distBin })
    assert.equal(ok.present, true)
    await writeFile(path.join(resourcesBin, 'ffmpeg'), Buffer.concat([elf, Buffer.from('x')]))
    await assert.rejects(assertPackagedFfmpeg({ platform: 'linux', arch: 'x64', resourcesBin, distBin }), /does not match/)
    const absent = await assertPackagedFfmpeg({
      platform: 'darwin',
      arch: 'arm64',
      resourcesBin: path.join(root, 'missing'),
      distBin,
    })
    assert.equal(absent.present, false)
    await assert.rejects(assertPackagedFfmpeg({
      platform: 'linux',
      arch: 'x64',
      resourcesBin: path.join(root, 'missing'),
      distBin,
    }), /must be packaged/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
