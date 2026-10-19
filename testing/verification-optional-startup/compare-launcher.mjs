import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const evidence = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(evidence, '../..')
const workspace = process.argv[2]
assert(workspace, 'Pass the frozen metadata comparison workspace')
const before = path.resolve(workspace, 'metadata'), after = path.resolve(workspace, 'launcher')
await cp(before, after, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
const changed = ['App.tsx', 'AutomationPanel.tsx', 'AutomationPanelLauncher.tsx'], hashes = {}
for (const name of changed) {
  const relative = `frontend/design-client/src/${name}`
  let source = await readFile(path.join(repo, relative), 'utf8')
  if (name === 'App.tsx') {
    const old = await readFile(path.join(before, relative), 'utf8')
    // Refuse unrelated concurrent App changes in this measured UI-only patch.
    assert.equal(source, old.replace("import { AutomationPanel } from './AutomationPanel'", "import { AutomationPanel } from './AutomationPanelLauncher'"))
  }
  if (name === 'AutomationPanel.tsx') {
    const old = await readFile(path.join(before, relative), 'utf8')
    const start = old.indexOf('export function AutomationPanel('), end = old.indexOf('export function AutomationDialog(', start)
    assert.equal(source, old.slice(0, start) + "// Compatibility entry: callers keep the same public button component while\n// App imports its lightweight launcher without loading this optional dialog.\nexport { AutomationPanel } from './AutomationPanelLauncher'\n" + old.slice(end))
  }
  await writeFile(path.join(after, relative), source)
  hashes[relative] = createHash('sha256').update(source).digest('hex')
}
await writeFile(path.join(evidence, 'snapshot-changes.launcher.json'), JSON.stringify(hashes, null, 2) + '\n')
const require = createRequire(path.join(after, 'frontend/design-client/package.json'))
const { build, version } = await import(pathToFileURL(require.resolve('vite')).href)
let graph
await build({
  root: path.join(after, 'frontend/design-client'), configFile: path.join(after, 'frontend/design-client/vite.config.ts'), publicDir: false,
  build: { outDir: path.resolve(workspace, 'out-launcher'), emptyOutDir: true, copyPublicDir: false, sourcemap: true, manifest: true },
  plugins: [{ name: 'record-startup-module-graph', generateBundle(_options, bundle) {
    graph = Object.fromEntries(Object.values(bundle).filter(entry => entry.type === 'chunk').map(entry => [entry.fileName, {
      isEntry: entry.isEntry, isDynamicEntry: entry.isDynamicEntry, imports: entry.imports, dynamicImports: entry.dynamicImports,
      codeBytes: Buffer.byteLength(entry.code), gzipBytes: gzipSync(entry.code).length,
      modules: Object.fromEntries(Object.entries(entry.modules).map(([id, module]) => [id.replaceAll(after, '<snapshot>'), { renderedLength: module.renderedLength }])),
    }]))
  } }],
})
assert(graph)
for (const [file, chunk] of Object.entries(graph)) {
  const emitted = await readFile(path.resolve(workspace, 'out-launcher', file))
  chunk.generateBundleCodeBytes = chunk.codeBytes; chunk.generateBundleGzipBytes = chunk.gzipBytes
  chunk.codeBytes = emitted.length; chunk.gzipBytes = gzipSync(emitted).length
}
function summarize(graph) {
  const entry = Object.entries(graph).find(([, chunk]) => chunk.isEntry)
  assert(entry)
  const closure = new Set()
  function visit(file) { if (closure.has(file)) return; closure.add(file); for (const imported of graph[file]?.imports ?? []) visit(imported) }
  visit(entry[0])
  const files = [...closure].filter(file => graph[file])
  const modules = [...new Set(files.flatMap(file => Object.keys(graph[file].modules)))].sort()
  return { entry: entry[0], initialStaticFiles: files, initialStaticCodeBytes: files.reduce((n, file) => n + graph[file].codeBytes, 0),
    initialStaticGzipBytes: files.reduce((n, file) => n + graph[file].gzipBytes, 0), initialStaticModuleCount: modules.length,
    allMainGraphCodeBytes: Object.values(graph).reduce((n, chunk) => n + chunk.codeBytes, 0), allMainGraphGzipBytes: Object.values(graph).reduce((n, chunk) => n + chunk.gzipBytes, 0),
    selectedModules: Object.entries(graph).flatMap(([file, chunk]) => Object.keys(chunk.modules).filter(id => /(?:AutomationPanel|react-dom-server|automation\/(?:bridge|app-export|export)\.ts)/.test(id)).map(id => ({ id, chunk: file, initialStatic: closure.has(file) }))),
    staticModules: modules,
  }
}
const previousGraph = JSON.parse(await readFile(path.join(evidence, 'build-graph.metadata.json'), 'utf8'))
const previous = summarize(previousGraph), current = summarize(graph)
assert(previous.selectedModules.find(module => module.id.endsWith('/AutomationPanel.tsx'))?.initialStatic)
assert.equal(current.selectedModules.find(module => module.id.endsWith('/AutomationPanel.tsx'))?.initialStatic, false)
assert(current.selectedModules.find(module => module.id.endsWith('/AutomationPanelLauncher.tsx'))?.initialStatic)
assert(current.selectedModules.find(module => module.id.endsWith('/automation/bridge.ts'))?.initialStatic)
assert(current.selectedModules.some(module => /react-dom-server/.test(module.id) && module.initialStatic))
await writeFile(path.join(evidence, 'build-graph.launcher.json'), JSON.stringify(graph, null, 2) + '\n')
const summary = { classification: 'Actual Vite production artifact/module placement only; not browser startup, milliseconds, FPS or network transfer.', viteVersion: version, changedSources: changed, before: previous, after: current,
  delta: Object.fromEntries(['initialStaticCodeBytes', 'initialStaticGzipBytes', 'initialStaticModuleCount', 'allMainGraphCodeBytes', 'allMainGraphGzipBytes'].map(key => [key, current[key] - previous[key]])) }
await writeFile(path.join(evidence, 'launcher-build-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, before: { ...previous, staticModules: undefined }, after: { ...current, staticModules: undefined } }, null, 2))
