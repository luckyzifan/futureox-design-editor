import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = path.resolve(desktop, '../design-client')
const text = name => readFile(path.join(desktop, name), 'utf8')
const icon = name => readFile(path.join(desktop, 'assets/branding', name))

test('original vector master is local, script-free and not a remote brand image', async () => {
  const svg = await readFile(path.join(client, 'public/branding/futureox-desgin.svg'), 'utf8')
  assert.match(svg, /viewBox="0 0 512 512"/)
  assert.match(svg, /Futureox \/ original F-D brand icon/)
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|href="(?!#)|figma|electron/i)
  assert.ok((svg.match(/<path /g) || []).length >= 3)
})
test('PNG resources have correct size and transparent RGBA data', async () => {
  for (const size of [16,32,64,128,256,512,1024]) {
    const png = await icon(size === 1024 ? 'futureox-desgin.png' : `futureox-desgin-${size}.png`)
    assert.equal(png.subarray(0,8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
    assert.equal(png[25], 6)
  }
})
test('Windows ICO contains genuine multi-size entries and macOS ICNS has valid chunks', async () => {
  const ico = await icon('futureox-desgin.ico')
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1)
  const sizes=[]
  for(let i=0;i<ico.readUInt16LE(4);i++) {
    const offset=6+i*16, length=ico.readUInt32LE(offset+8), start=ico.readUInt32LE(offset+12)
    sizes.push(ico[offset] || 256)
    assert.ok(start+length<=ico.length && length>0)
  }
  assert.deepEqual(sizes,[16,24,32,48,64,128,256])
  const icns = await icon('futureox-desgin.icns')
  assert.equal(icns.toString('ascii',0,4),'icns'); assert.equal(icns.readUInt32BE(4),icns.length)
  const chunks=[]; let offset=8
  while(offset<icns.length) {
    chunks.push(icns.toString('ascii',offset,offset+4)); const size=icns.readUInt32BE(offset+4)
    assert.ok(size>=8 && offset+size<=icns.length); offset+=size
  }
  assert.equal(offset,icns.length); assert.ok(chunks.includes('ic10'))
})
test('Web favicon, touch icon, manifest and editor share the original brand', async () => {
  const html=await readFile(path.join(client,'index.html'),'utf8')
  for(const resource of ['branding/futureox-desgin.svg','branding/favicon.ico','branding/apple-touch-icon.png','manifest.webmanifest']) {
    assert.ok(html.includes(`href="/${resource}"`)); await access(path.join(client,'public',resource))
  }
  const manifest=JSON.parse(await readFile(path.join(client,'public/manifest.webmanifest'),'utf8'))
  assert.equal(manifest.name,'Futureox Design')
  for(const item of manifest.icons) await access(path.join(client,'public',item.src))
  const app=await readFile(path.join(client,'src/App.tsx'),'utf8')
  assert.match(app, /className="brand-mark" src="\/branding\/futureox-desgin.svg"/)
  assert.doesNotMatch(app, /className="brand-mark">f</)
})
test('development and packaged windows use owned assets on every platform', async () => {
  const main=await text('src/main.mjs')
  assert.match(main, /path.resolve\(here, '\.\.\/assets\/branding'/)
  assert.match(main, /process.platform === 'win32' \? 'futureox-desgin.ico' : process.platform === 'darwin' \? 'futureox-desgin-macos.png' : 'futureox-desgin.png'/)
  assert.match(main, /app.dock\?\.setIcon\(brandIcon\)/)
  assert.match(main, /new BrowserWindow\(\{\s*icon: brandIcon,/)
  assert.doesNotMatch(main, /icon:\s*[^\n]*(electron\.(png|ico|icns)|default_app)/i)
  const pack=await text('scripts/package.mjs')
  assert.match(pack, /cp\(path.join\(root, 'assets'\), path.join\(staging, 'assets'\)/)
  assert.match(pack, /icon: path.join\(root, 'assets\/branding', `futureox-desgin\.\$\{process.platform === 'darwin' \? 'icns' : process.platform === 'win32' \? 'ico' : 'png'\}`\)/)
  const inputs=await text('scripts/build-inputs.mjs')
  assert.ok(inputs.includes("'frontend/design-desktop/assets'"))
  const verify=await text('scripts/verify-package.mjs')
  assert.ok(verify.includes("[path.join(desktop, 'assets'), path.join(temporary, 'assets')]"))
})

test('macOS has a distinct selected rounded-square source and native PNG', async () => {
  const mac = await icon('futureox-desgin-macos.png')
  assert.equal(mac.readUInt32BE(16), 1024); assert.equal(mac.readUInt32BE(20), 1024)
  assert.notDeepEqual(mac, await icon('futureox-desgin.png'))
  const svg = (await icon('futureox-desgin-macos.svg')).toString()
  assert.match(svg, /macOS icon presentation/)
  assert.match(svg, /3459d4/i)
  assert.doesNotMatch(svg, /73000000-0000-4000-8000-00000000000[6789]/)
  assert.doesNotMatch(svg, /74acdf|3978ac/i)
})
