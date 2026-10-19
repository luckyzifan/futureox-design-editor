import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// Capture a controlled metadata-only extraction against the previously frozen
// current-source baseline. No shared dist/public mutation or kernel build.
const evidence = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(evidence, '../..')
const workspace = process.argv[2]
assert(workspace, 'Pass the workspace containing the frozen before/ source tree')
const before = path.resolve(workspace, 'before'), after = path.resolve(workspace, 'metadata')
await cp(before, after, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
const changed = ['export.tsx', 'export-metadata.ts', 'ExportPanel.tsx', 'NodeExportPanel.tsx', 'clipboard-export.ts']
const changes = {}
for (const name of changed) {
  const relative = `frontend/design-client/src/${name}`
  const source = await readFile(path.join(repo, relative))
  await writeFile(path.join(after, relative), source)
  changes[relative] = createHash('sha256').update(source).digest('hex')
}
await writeFile(path.join(evidence, 'snapshot-changes.metadata.json'), JSON.stringify(changes, null, 2) + '\n')
const require = createRequire(path.join(before, 'frontend/design-client/package.json'))
const { build, version } = await import(pathToFileURL(require.resolve('vite')).href)
const results = {}
for (const [label, root] of [['before', before], ['metadata', after]]) {
  const client = path.join(root, 'frontend/design-client')
  let graph
  const normalize = id => id.replaceAll(root, '<snapshot>')
  await build({
    root: client, configFile: path.join(client, 'vite.config.ts'), publicDir: false,
    build: { outDir: path.resolve(workspace, `out-${label}`), emptyOutDir: true, copyPublicDir: false, sourcemap: true, manifest: true },
    plugins: [{ name: 'record-startup-module-graph', generateBundle(_options, bundle) {
      graph = Object.fromEntries(Object.values(bundle).filter(entry => entry.type === 'chunk').map(entry => [entry.fileName, {
        isEntry: entry.isEntry, isDynamicEntry: entry.isDynamicEntry, imports: entry.imports, dynamicImports: entry.dynamicImports,
        codeBytes: Buffer.byteLength(entry.code), gzipBytes: gzipSync(entry.code).length,
        modules: Object.fromEntries(Object.entries(entry.modules).map(([id, module]) => [normalize(id), { renderedLength: module.renderedLength }])),
      }]))
    } }],
  })
  assert(graph, 'Expected actual production module graph')
  // Output finalization can change code after generateBundle. Size the files
  // actually written to disk; keep hook-stage sizes explicitly labelled.
  for (const [file, chunk] of Object.entries(graph)) {
    const emitted = await readFile(path.resolve(workspace, `out-${label}`, file))
    chunk.generateBundleCodeBytes = chunk.codeBytes; chunk.generateBundleGzipBytes = chunk.gzipBytes
    chunk.codeBytes = emitted.length; chunk.gzipBytes = gzipSync(emitted).length
  }
  const entry = Object.entries(graph).find(([, chunk]) => chunk.isEntry)
  assert(entry, 'Expected actual entry chunk')
  const closure = new Set()
  function visit(file) { if (closure.has(file)) return; closure.add(file); for (const imported of graph[file]?.imports ?? []) visit(imported) }
  visit(entry[0])
  const staticFiles = [...closure].filter(file => graph[file])
  const staticModules = [...new Set(staticFiles.flatMap(file => Object.keys(graph[file].modules)))].sort()
  const exportModules = Object.entries(graph).flatMap(([file, chunk]) => Object.keys(chunk.modules).filter(id => /\/(export(?:-metadata)?\.tsx?|(?:app-export|bridge)\.ts|(?:react-dom-server|react-dom-server-legacy)\.[^/]+)$/.test(id)).map(id => ({ id, chunk: file, initialStatic: closure.has(file) })))
  results[label] = {
    entry: entry[0], initialStaticFiles: staticFiles, initialStaticCodeBytes: staticFiles.reduce((total, file) => total + graph[file].codeBytes, 0),
    initialStaticGzipBytes: staticFiles.reduce((total, file) => total + graph[file].gzipBytes, 0), initialStaticModuleCount: staticModules.length,
    allCodeBytes: Object.values(graph).reduce((total, chunk) => total + chunk.codeBytes, 0),
    allGzipBytes: Object.values(graph).reduce((total, chunk) => total + chunk.gzipBytes, 0),
    exportModules, staticModules,
  }
  await writeFile(path.join(evidence, `build-graph.${label}.json`), JSON.stringify(graph, null, 2) + '\n')
}
// This first stage intentionally demonstrates that helper extraction is not
// sufficient alone: automation still statically imports the synchronous SVG API.
for (const label of ['before', 'metadata']) assert(results[label].exportModules.some(module => /react-dom-server/.test(module.id) && module.initialStatic), 'The unsplit automation path must still retain React server rendering')
const summary = { classification: 'Actual Vite production artifact/module placement only; not browser startup, milliseconds, FPS or network transfer.', viteVersion: version, changedSources: changed, ...results,
  delta: Object.fromEntries(['initialStaticCodeBytes', 'initialStaticGzipBytes', 'initialStaticModuleCount', 'allCodeBytes', 'allGzipBytes'].map(key => [key, results.metadata[key] - results.before[key]])),
}
await writeFile(path.join(evidence, 'build-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, before: { ...summary.before, staticModules: undefined }, metadata: { ...summary.metadata, staticModules: undefined } }, null, 2))
