/** Rasterize the committed F mark. Requires @resvg/resvg-js on NODE_PATH or /tmp/brand-render. */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const publicDir = path.join(root, 'frontend/design-client/public/branding')
const assetDir = path.join(root, 'frontend/design-desktop/assets/branding')

const { Resvg } = await import('@resvg/resvg-js').catch(() => import('/tmp/brand-render/node_modules/@resvg/resvg-js/index.js'))

function raster(svg, size) {
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render()
  if (rendered.width !== size || rendered.height !== size) throw new Error(`expected ${size}px, got ${rendered.width}x${rendered.height}`)
  const png = Buffer.from(rendered.asPng())
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a png')
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size || png[25] !== 6) throw new Error(`bad ihdr for ${size}`)
  return png
}
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
  let offset = header.length
  const parts = [header]
  images.forEach((image, index) => {
    const at = 6 + index * 16
    header[at] = image.size >= 256 ? 0 : image.size
    header[at + 1] = image.size >= 256 ? 0 : image.size
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(image.png.length, at + 8); header.writeUInt32LE(offset, at + 12)
    offset += image.png.length
    parts.push(image.png)
  })
  return Buffer.concat(parts)
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.write(type, 0, 4, 'ascii'); head.writeUInt32BE(8 + data.length, 4)
  return Buffer.concat([head, data])
}
function icns(entries) {
  const body = Buffer.concat(entries.map(([type, png]) => chunk(type, png)))
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii'); head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

const master = await readFile(path.join(publicDir, 'futureox-desgin.svg'), 'utf8')
const mac = await readFile(path.join(assetDir, 'futureox-desgin-macos.svg'), 'utf8')
const png = async (svg, size) => raster(svg, size)
const main1024 = await png(master, 1024)
await writeFile(path.join(assetDir, 'futureox-desgin.png'), main1024)
for (const size of [16, 32, 64, 128, 256, 512]) await writeFile(path.join(assetDir, `futureox-desgin-${size}.png`), await png(master, size))
await writeFile(path.join(publicDir, 'futureox-desgin-192.png'), await png(master, 192))
await writeFile(path.join(publicDir, 'futureox-desgin-512.png'), await png(master, 512))
await writeFile(path.join(publicDir, 'apple-touch-icon.png'), await png(master, 180))
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
await writeFile(path.join(assetDir, 'futureox-desgin.ico'), ico(await Promise.all(icoSizes.map(async size => ({ size, png: await png(master, size) })))))
await writeFile(path.join(publicDir, 'favicon.ico'), ico(await Promise.all([16, 32, 48].map(async size => ({ size, png: await png(master, size) })))))
const mac1024 = await png(mac, 1024)
await writeFile(path.join(assetDir, 'futureox-desgin-macos.png'), mac1024)
const macPng = async size => png(mac, size)
await writeFile(path.join(assetDir, 'futureox-desgin.icns'), icns([
  ['ic07', await macPng(128)], ['ic08', await macPng(256)], ['ic09', await macPng(512)], ['ic10', mac1024],
  ['ic11', await macPng(64)], ['ic12', await macPng(128)], ['ic13', await macPng(512)], ['ic14', mac1024],
]))
if (main1024.equals(mac1024)) throw new Error('macOS presentation matches the standalone mark')
console.log('brand rasters written')
