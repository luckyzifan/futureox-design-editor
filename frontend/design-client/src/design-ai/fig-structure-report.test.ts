import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { decodeFig, importFig } from '../import-fig'
import type { DesignDocument } from '../model'
import { outlineDocument } from './format-gap'

const repoFiles = [
  ['sections.fig', '../../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/sections.fig'],
  ['stacks_wrap.fig', '../../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/stacks_wrap.fig'],
  ['corners.fig', '../../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/corners.fig'],
  ['structure.fig', '../../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/structure.fig'],
] as const
const extraRoot = '/cursor/stores/bot/compare-fixtures'

function tally(doc: DesignDocument) {
  const kinds: Record<string, number> = {}
  for (const node of Object.values(doc.nodes)) kinds[node.kind] = (kinds[node.kind] || 0) + 1
  const outline = outlineDocument(doc)
  const linked = Object.values(doc.nodes).filter(node => node.instance || node.component)
  return {
    pages: doc.pages.map(page => page.name),
    pageCount: doc.pages.length,
    nodeCount: Object.keys(doc.nodes).length,
    kinds,
    frames: outline.pages.flatMap(page => page.frames).slice(0, 24),
    texts: outline.pages.flatMap(page => page.texts).slice(0, 24),
    frameCount: outline.pages.reduce((sum, page) => sum + page.frames.length, 0),
    textCount: outline.pages.reduce((sum, page) => sum + page.texts.length, 0),
    maskGroups: Object.values(doc.nodes).filter(node => node.name === 'Mask group').length,
    components: linked.filter(node => node.component).length,
    instances: linked.filter(node => node.instance).length,
    instancesMissingComponent: linked.filter(node => node.instance && !node.instance.componentId).length,
  }
}

function sourceInventory(bytes: Uint8Array) {
  const { data } = decodeFig(bytes)
  const records = new Map<string, any>()
  for (const change of data.nodeChanges || []) {
    const id = change.guid ? `${change.guid.sessionID}:${change.guid.localID}` : ''
    if (change.phase === 'REMOVED') records.delete(id)
    else records.set(id, { ...records.get(id), ...change })
  }
  const types: Record<string, number> = {}
  const canvases: string[] = []
  const texts: string[] = []
  let internalOnly = 0
  for (const record of records.values()) {
    const type = String(record.type || 'UNKNOWN')
    types[type] = (types[type] || 0) + 1
    if (record.internalOnly) internalOnly += 1
    if (type === 'CANVAS') canvases.push(String(record.name || ''))
    const text = record.textData?.characters || record.characters
    if (typeof text === 'string' && text) texts.push(text)
  }
  return { sourceRecords: records.size, sourceTypes: types, internalOnly, canvases, sourceTexts: texts.slice(0, 24) }
}

function rowFor(file: string, payload: Uint8Array) {
  const base = {
    file,
    bytes: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
  }
  let source: ReturnType<typeof sourceInventory> | { sourceError: string }
  try { source = sourceInventory(payload) } catch (error) { source = { sourceError: error instanceof Error ? error.message : String(error) } }
  const started = performance.now()
  try {
    const imported = importFig(payload, file)
    return {
      ...base,
      importMs: performance.now() - started,
      backend: imported.backend,
      warnings: imported.warnings,
      ...source,
      ...tally(imported.document),
    }
  } catch (error) {
    return {
      ...base,
      importMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
      ...source,
    }
  }
}

test('report structural import of the real Fig fixtures', () => {
  const rows = repoFiles.map(([name, relative]) => rowFor(name, new Uint8Array(readFileSync(new URL(relative, import.meta.url)))))
  const extra = process.env.FIG_STRUCTURE_REPORT && existsSync(extraRoot)
    ? readdirSync(extraRoot).filter(name => name.endsWith('.fig')).sort().map(name => rowFor(name, new Uint8Array(readFileSync(`${extraRoot}/${name}`))))
    : []
  const report = process.env.FIG_STRUCTURE_REPORT
  if (report) {
    mkdirSync(report.slice(0, report.lastIndexOf('/')), { recursive: true })
    writeFileSync(report, JSON.stringify({
      collectedAt: new Date().toISOString(),
      scope: 'typescript-fig import. Not pixels, GPU, or Electron.',
      extraRoot: existsSync(extraRoot) ? extraRoot : null,
      rows,
      extra,
    }, null, 2))
  }
  for (const row of rows) {
    expect('pageCount' in row && row.pageCount, row.file).toBeGreaterThan(0)
    expect('nodeCount' in row && row.nodeCount, row.file).toBeGreaterThan(0)
  }
  console.log('FIG_STRUCTURE', JSON.stringify([...rows, ...extra].map(row => ({
    file: row.file,
    importMs: row.importMs,
    error: 'error' in row ? row.error : undefined,
    pages: 'pageCount' in row ? row.pageCount : 0,
    nodes: 'nodeCount' in row ? row.nodeCount : 0,
    warnings: 'warnings' in row ? row.warnings.length : 0,
  }))))
})
