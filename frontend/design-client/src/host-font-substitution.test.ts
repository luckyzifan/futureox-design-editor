// Issue #1263. Host faces are the only way production WASM/PNG exports can use
// a locally installed source font: the renderer itself never probes the host.
// These tests pin the exact family + style identity rule for the seven 117
// source faces and the document binding that makes canvas and export agree.
import { expect, test, vi } from 'vitest'
import { blank, defaultTextStyle, node, type DesignDocument } from './model'
import { emptySystem } from './design-system'
import { matchSourceFontsInDocument } from './font-management'
import { sourceFonts } from './font-matching'
import { matchHostSourceFonts, resourceId, resourceSha1, type HostFontFace } from './host-font-substitution'

const bytesFor = (label: string) => Buffer.from(`font-bytes:${label}`).toString('base64')
const resource = (label: string) => ({ family: label, data: bytesFor(label), index: 0, postscript: label })

function face(family: string, style: string, postscript = `${family}-${style}`): HostFontFace {
  return { id: postscript, family, style, postscript, index: 0 }
}

const HOST: HostFontFace[] = [
  face('DINPro', 'Medium'),
  face('DINPro', 'Regular'),
  face('Alibaba PuHuiTi', 'Medium'),
  face('Alibaba PuHuiTi', 'Bold'),
  face('Alibaba PuHuiTi', 'Regular'),
  face('YouSheBiaoTiHei', 'Regular', 'YouSheBiaoTiHei'),
  face('Barlow', 'Medium'),
]
const read = (host: HostFontFace) => Promise.resolve(resource(`${host.family} ${host.style}`))

function fixture() {
  const doc = blank('Host font matching')
  doc.schemaVersion = 4
  doc.fonts = {}
  doc.designSystem = emptySystem()
  doc.designSystem.fontSources = {}
  const add = (id: string, style?: string, runs?: Record<string, string>, base = 'default') => {
    const n = node('text', 0, 0, 240, 40)
    n.id = id
    n.text = 'BigRed small rest'
    n.textStyle = { ...defaultTextStyle(), fontId: base }
    n.textRuns = Object.keys(runs ?? {}).map((_, index) => ({ start: index === 0 ? 0 : 5, end: index === 0 ? 1 : 6, fontId: 'default' }))
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
    doc.designSystem!.fontSources![n.id] = {
      ...(style ? { style } : {}),
      ...(runs ? { runs } : {}),
    }
    return n
  }
  add('din-medium', 'DINPro-Medium')
  add('din-regular', 'DIN Pro-Regular')
  add('puhui-bold', 'Alibaba PuHuiTi-Bold')
  add('puhui-runs', undefined, { 0: 'Alibaba PuHuiTi-Medium', 1: 'Alibaba PuHuiTi-Regular' })
  add('youshe', 'YouSheBiaoTiHei')
  add('barlow', 'Barlow-Medium')
  return doc
}

test('the seven 117 source faces bind to exact installed family and style faces', async () => {
  const doc = fixture()
  const before = structuredClone(doc.designSystem!.fontSources)
  const seen: string[] = []
  const result = await matchHostSourceFonts(doc, HOST, async host => {
    seen.push(host.id)
    return read(host)
  })
  expect(result.missing).toEqual([])
  expect([...result.matched.keys()].sort()).toEqual([
    'Alibaba PuHuiTi-Bold',
    'Alibaba PuHuiTi-Medium',
    'Alibaba PuHuiTi-Regular',
    'Barlow-Medium',
    'DIN Pro-Regular',
    'DINPro-Medium',
    'YouSheBiaoTiHei',
  ])
  // One read per installed face, even when several source names share it.
  expect(seen.sort()).toEqual(HOST.map(host => host.id).sort())

  const edit = matchSourceFontsInDocument(doc, result.matched)
  expect(edit.changed).toBe(7)
  const id = (name: string) => result.matched.get(name)!.id
  expect(sourceFonts(doc, doc.nodes['din-medium']).style).toBe('DINPro-Medium')
  const expectId = async (fontId: string | undefined, label: string) => expect(fontId).toBe(await resourceId(resource(label)))
  await expectId(doc.nodes['din-medium'].textStyle?.fontId, 'DINPro Medium')
  await expectId(doc.nodes['din-regular'].textStyle?.fontId, 'DINPro Regular')
  await expectId(doc.nodes['puhui-bold'].textStyle?.fontId, 'Alibaba PuHuiTi Bold')
  await expectId(doc.nodes['youshe'].textStyle?.fontId, 'YouSheBiaoTiHei Regular')
  await expectId(doc.nodes['barlow'].textStyle?.fontId, 'Barlow Medium')
  const runs = doc.nodes['puhui-runs'].textRuns!
  expect(runs[0].fontId).toBe(id('Alibaba PuHuiTi-Medium'))
  expect(runs[0].fontId).not.toBe(id('Alibaba PuHuiTi-Regular'))
  expect(runs[1].fontId).toBe(id('Alibaba PuHuiTi-Regular'))
  // Authored source identity is provenance and never moves.
  expect(doc.designSystem!.fontSources).toEqual(before)
})

test('a missing exact weight stays missing instead of borrowing another cut', async () => {
  const doc = fixture()
  const result = await matchHostSourceFonts(doc, HOST.filter(host => host.id !== 'Barlow-Medium'), read)
  expect(result.missing).toEqual(['Barlow-Medium'])
  const edit = matchSourceFontsInDocument(doc, result.matched)
  expect(edit.changed).toBe(6)
  expect(doc.nodes['youshe'].textStyle?.fontId).not.toBe('default')
})

test('a digest-qualified source only accepts bytes with that SHA-1', async () => {
  const doc = fixture()
  doc.designSystem!.fontSources!['din-medium'].digest = await resourceSha1(resource('a different DINPro-Medium file'))
  const result = await matchHostSourceFonts(doc, HOST, read)
  expect(result.missing).toEqual([`DINPro-Medium 摘要 ${doc.designSystem!.fontSources!['din-medium'].digest}`])
  expect(doc.nodes['din-medium'].textStyle?.fontId).toBe('default')
})

test('a nearest static weight is never an automatic identity', async () => {
  const doc = fixture()
  const lightOnly = HOST.filter(host => host.id !== 'Barlow-Medium').map(host =>
    host.family === 'DINPro' && host.style === 'Medium' ? face('DINPro', 'Light') : host)
  const result = await matchHostSourceFonts(doc, lightOnly, read)
  expect(result.missing).toContain('DINPro-Medium')
  expect(result.matched.has('DINPro-Medium')).toBe(false)
  expect(doc.nodes['din-medium'].textStyle?.fontId).toBe('default')
  // The exact Regular face still resolves; only the unknown Medium stays open.
  expect(result.matched.has('DIN Pro-Regular')).toBe(true)
})