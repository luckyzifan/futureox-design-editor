#!/usr/bin/env bun
// Static Figma-plugin compatibility triage over the public fixture set.
//
// For every plugin manifest under testing/fixtures/figma-plugins-public-20261106
// this extracts `figma.*` API usage (plus node-property access) from the
// manifest's main/ui files and cross-references the rich host's
// PLUGIN_API_COVERAGE matrix. Plugin code is NEVER executed: the fixtures are
// untrusted downloads and this is a read-only scan.
import { PLUGIN_API_COVERAGE } from '../frontend/design-client/src/plugins/rich-host/coverage.ts'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('.', import.meta.url).pathname
const FIXTURES = join(ROOT, 'fixtures/figma-plugins-public-20261106')
const MAX_SOURCE_BYTES = 4 * 1024 * 1024

const matrix = new Map(PLUGIN_API_COVERAGE.map(entry => [entry.api, entry]))
// Node-property APIs (e.g. 'TextNode.fontName') are detected by property name
// on any receiver; the note marks them as possible rather than exact usage.
const propertyApis = PLUGIN_API_COVERAGE
  .filter(entry => !entry.api.startsWith('figma.'))
  .map(entry => ({ ...entry, property: entry.api.split('.').pop() }))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) walk(path, out)
    else if (name === 'manifest.json' && info.size <= 64 * 1024) out.push(path)
  }
  return out
}

function readBounded(path) {
  const data = readFileSync(path)
  return data.length > MAX_SOURCE_BYTES ? null : data.toString('utf8')
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'dist' || name === 'build') continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) sourceFiles(path, out)
    else if (/\.(js|ts|tsx|jsx|html)$/.test(name) && out.length < 200) out.push(path)
  }
  return out
}

function scanPluginSources(dir, manifest, used, uiMessagingRef) {
  const declared = [manifest.main, manifest.ui].filter(file => typeof file === 'string')
  const declaredPresent = declared.filter(file => { try { statSync(join(dir, file)); return true } catch { return false } })
  // Unbuilt checkouts point main at dist/ artifacts: fall back to the plugin
  // tree's sources so the scan still measures what the plugin will call.
  const files = declaredPresent.length ? declaredPresent.map(file => join(dir, file)) : sourceFiles(dir)
  for (const path of files) {
    try {
      const source = readBounded(path)
      if (source == null) continue
      figmaChains(source, used)
      propertyHits(source, used)
      if (/parent\.postMessage/.test(source)) uiMessagingRef.hit = true
    } catch { /* unreadable file */ }
  }
  return files.length
}

function figmaChains(source, used) {
  const re = /\bfigma\s*\.\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g
  for (const match of source.matchAll(re)) {
    const chain = match[0].replace(/\s+/g, '')
    // Trim trailing member reads (e.g. figma.currentPage.selection.length)
    for (let depth = 4; depth >= 1; depth--) {
      const parts = chain.split('.').slice(0, depth + 1).join('.')
      if (matrix.has(parts)) { used.add(parts); break }
      if (depth === 1) used.add(chain.split('.').slice(0, 2).join('.'))
    }
  }
}

function propertyHits(source, used) {
  for (const entry of propertyApis) {
    const re = new RegExp(`\\.${entry.property}\\b`)
    if (re.test(source)) used.add(entry.api)
  }
}

function classify(used) {
  const summary = { supported: [], partial: [], unsupported: [], unknown: [], namespace: [] }
  for (const api of used) {
    // URL/comment artifacts such as figma.com are not API calls.
    if (/^figma\.(com|www|net|org)$/.test(api)) continue
    const entry = matrix.get(api)
    if (entry) { summary[entry.status].push(api); continue }
    // A bare namespace (e.g. figma.viewport) whose children are covered counts
    // as partial; only truly unlisted calls stay unknown.
    if ([...matrix.keys()].some(listed => listed.startsWith(`${api}.`))) summary.namespace.push(api)
    else summary.unknown.push(api)
  }
  for (const key of Object.keys(summary)) summary[key].sort()
  return summary
}

const plugins = []
for (const repo of readdirSync(FIXTURES).sort()) {
  const repoDir = join(FIXTURES, repo)
  if (!statSync(repoDir).isDirectory()) continue
  let found = 0
  for (const manifestPath of walk(repoDir)) {
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
    catch { continue }
    if (typeof manifest.main !== 'string') continue // not a Figma plugin manifest
    const editorType = manifest.editorType ?? ['figma']
    if (!editorType.includes('figma')) continue
    const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/'))
    const used = new Set()
    const messaging = { hit: false }
    const files = scanPluginSources(dir, manifest, used, messaging)
    const summary = classify(used)
    const usedCount = summary.supported.length + summary.partial.length + summary.namespace.length + summary.unsupported.length + summary.unknown.length
    plugins.push({
      repo,
      plugin: manifest.name ?? manifest.id ?? manifestPath,
      scanned: files,
      fromSource: !(typeof manifest.main === 'string' && (() => { try { statSync(join(dir, manifest.main)); return true } catch { return false } })()),
      uiMessaging: messaging.hit,
      used: usedCount,
      ...summary,
      unsupportedNotes: summary.unsupported.map(api => matrix.get(api)?.notes ?? ''),
    })
    found += 1
  }
  // Repos whose plugins ship only as unbuilt checkouts still get a repo-level
  // scan so the fixture contributes compatibility signal.
  if (found === 0) {
    const used = new Set()
    const messaging = { hit: false }
    const files = sourceFiles(repoDir)
    for (const path of files) {
      try {
        const source = readBounded(path)
        if (source == null) continue
        figmaChains(source, used)
        propertyHits(source, used)
        if (/parent\.postMessage/.test(source)) messaging.hit = true
      } catch { /* unreadable file */ }
    }
    const summary = classify(used)
    plugins.push({
      repo,
      plugin: '(repo-level source scan)',
      scanned: files.length,
      fromSource: true,
      uiMessaging: messaging.hit,
      used: summary.supported.length + summary.partial.length + summary.namespace.length + summary.unsupported.length + summary.unknown.length,
      ...summary,
      unsupportedNotes: summary.unsupported.map(api => matrix.get(api)?.notes ?? ''),
    })
  }
}

const supported = plugins.reduce((n, p) => n + (p.supported?.length ?? 0), 0)
const partial = plugins.reduce((n, p) => n + (p.partial?.length ?? 0), 0)
const unsupported = plugins.reduce((n, p) => n + (p.unsupported?.length ?? 0), 0)
const unknown = plugins.reduce((n, p) => n + (p.unknown?.length ?? 0), 0)

console.log(`扫描 ${plugins.length} 个 figma 编辑器插件（静态，未执行）\n`)
console.log('API 使用总量: supported=%d partial=%d unsupported=%d unknown=%d', supported, partial, unsupported, unknown)
console.log('整体兼容率（supported+partial / 全部已知用法）: %s%\n', Math.round(((supported + partial) / Math.max(1, supported + partial + unsupported)) * 1000) / 10)

const blockerCount = new Map()
for (const plugin of plugins)
  for (const api of plugin.unsupported ?? []) blockerCount.set(api, (blockerCount.get(api) ?? 0) + 1)
console.log('\n按插件数排序的 unsupported 阻断 API:')
for (const [api, count] of [...blockerCount.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${api.padEnd(46)} ${count} 个插件`)

console.log('\nunknown（矩阵未收录的 figma.* 用法）合计:')
const unknownCount = new Map()
for (const plugin of plugins)
  for (const api of plugin.unknown ?? []) unknownCount.set(api, (unknownCount.get(api) ?? 0) + 1)
for (const [api, count] of [...unknownCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
  console.log(`  ${api.padEnd(46)} ${count} 个插件`)

console.log('\n逐插件明细:')
for (const plugin of plugins) {
  const rate = Math.round((((plugin.supported?.length ?? 0) + (plugin.partial?.length ?? 0) + (plugin.namespace?.length ?? 0)) / Math.max(1, plugin.used)) * 100)
  const blockers = plugin.unsupported?.length ? plugin.unsupported.slice(0, 4).join(',') : '-'
  console.log(`  ${plugin.repo.padEnd(38)} ${String(plugin.plugin).slice(0, 36).padEnd(38)} 用${String(plugin.used).padEnd(4)} 兼容${String(rate).padStart(3)}% 阻断${blockers}`)
}

const reportPath = join(ROOT, '../test-results/figmaplugin-coverage.json')
await Bun.write(reportPath, JSON.stringify({ generated: new Date().toISOString(), totals: { supported, partial, unsupported, unknown }, blockers: [...blockerCount.entries()], plugins }, null, 2))
console.log('\nJSON 报告: %s', reportPath)
