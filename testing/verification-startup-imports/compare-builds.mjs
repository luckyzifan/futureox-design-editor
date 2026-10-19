import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// Frozen before/after snapshots differ only in these four production sources.
// No server, browser, GPU, kernel build, or shared dist/public mutation is used.
const evidence = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(evidence, '../..')
const workspace = process.argv[2]
assert(workspace, 'Pass a directory containing the frozen before/ source snapshot')
const before = path.resolve(workspace, 'before')
const after = path.resolve(workspace, 'after')
await cp(before, after, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
const changed = ['import-svg.ts', 'path-network.ts', 'editable-network.ts', 'engine.ts']
const inputs = {}
for (const name of changed) {
  const relative = `frontend/design-client/src/${name}`
  // Only incorporate this worker's import edit into engine/editable-network.
  // Other workers may have changed the live source since the snapshot capture.
  const source = ['engine.ts', 'editable-network.ts'].includes(name)
    ? (await readFile(path.join(before, relative), 'utf8')).replace("import { pathNetwork } from './import-svg'", "import { pathNetwork } from './path-network'")
    : await readFile(path.join(repo, relative), 'utf8')
  await writeFile(path.join(after, relative), source)
  inputs[relative] = createHash('sha256').update(source).digest('hex')
}
await writeFile(path.join(evidence, 'snapshot-changes.after.json'), JSON.stringify(inputs, null, 2) + '\n')
const require = createRequire(path.join(before, 'frontend/design-client/package.json'))
const { build, version } = await import(pathToFileURL(require.resolve('vite')).href)
const results = {}
for (const [label, root] of [['before', before], ['after', after]]) {
  const client = path.join(root, 'frontend/design-client')
  let graph
  const normalize = id => id.replaceAll(root, '<snapshot>')
  await build({
    root: client,
    configFile: path.join(client, 'vite.config.ts'),
    publicDir: false,
    build: { outDir: path.resolve(workspace, `out-${label}`), emptyOutDir: true, copyPublicDir: false, sourcemap: true, manifest: true },
    plugins: [{ name: 'record-startup-module-graph', generateBundle(_options, bundle) {
      graph = Object.fromEntries(Object.values(bundle).filter(entry => entry.type === 'chunk').map(entry => [entry.fileName, {
        isEntry: entry.isEntry, isDynamicEntry: entry.isDynamicEntry, imports: entry.imports, dynamicImports: entry.dynamicImports,
        codeBytes: Buffer.byteLength(entry.code), gzipBytes: gzipSync(entry.code).length,
        modules: Object.fromEntries(Object.entries(entry.modules).map(([id, module]) => [normalize(id), { renderedLength: module.renderedLength }])),
      }]))
    } }],
  })
  assert(graph, 'Expected module graph from the actual Vite build')
  const entry = Object.entries(graph).find(([, chunk]) => chunk.isEntry)
  assert(entry, 'Expected an emitted entry chunk')
  const closure = new Set()
  function visit(file) { if (closure.has(file)) return; closure.add(file); for (const imported of graph[file]?.imports ?? []) visit(imported) }
  visit(entry[0])
  const staticFiles = [...closure].filter(file => graph[file])
  const staticModules = [...new Set(staticFiles.flatMap(file => Object.keys(graph[file].modules)))].sort()
  const svgModules = Object.entries(graph).flatMap(([file, chunk]) => Object.keys(chunk.modules).filter(id => /\/(import-svg|svg-presentation|import-svg-viewport|path-network)\.ts$/.test(id)).map(id => ({ id, chunk: file, initialStatic: closure.has(file) })))
  results[label] = {
    entry: entry[0], initialStaticFiles: staticFiles, initialStaticCodeBytes: staticFiles.reduce((total, file) => total + graph[file].codeBytes, 0),
    initialStaticGzipBytes: staticFiles.reduce((total, file) => total + graph[file].gzipBytes, 0), initialStaticModuleCount: staticModules.length,
    svgModules, staticModules,
  }
  await writeFile(path.join(evidence, `build-graph.${label}.json`), JSON.stringify(graph, null, 2) + '\n')
}
assert(results.before.svgModules.find(module => module.id.endsWith('/import-svg.ts'))?.initialStatic, 'Negative-control baseline must include import-svg in the initial static chunk closure')
assert.equal(results.after.svgModules.find(module => module.id.endsWith('/import-svg.ts'))?.initialStatic, false, 'SVG document importer must be lazy after extraction')
assert(results.after.svgModules.find(module => module.id.endsWith('/path-network.ts'))?.initialStatic, 'Synchronous parser must remain in the initial static closure')
const summary = { classification: 'Actual Vite production-build artifact/module-graph comparison, not measured browser startup, latency, FPS, or network transfer.', viteVersion: version, changedSources: changed, ...results,
  delta: { initialStaticCodeBytes: results.after.initialStaticCodeBytes - results.before.initialStaticCodeBytes, initialStaticGzipBytes: results.after.initialStaticGzipBytes - results.before.initialStaticGzipBytes, initialStaticModuleCount: results.after.initialStaticModuleCount - results.before.initialStaticModuleCount },
}
await writeFile(path.join(evidence, 'build-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, before: { ...summary.before, staticModules: undefined }, after: { ...summary.after, staticModules: undefined } }, null, 2))
