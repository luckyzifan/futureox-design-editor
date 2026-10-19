import { readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
const evidence = path.dirname(fileURLToPath(import.meta.url)), workspace = process.argv[2]
const graphs = {}
for (const label of ['before', 'metadata', 'launcher']) {
  const file = path.join(evidence, `build-graph.${label}.json`)
  const graph = JSON.parse(await readFile(file, 'utf8'))
  await copyFile(file, path.join(evidence, `build-graph.generatebundle.${label}.json`))
  for (const [filename, chunk] of Object.entries(graph)) {
    const emitted = await readFile(path.join(workspace, `out-${label}`, filename))
    chunk.generateBundleCodeBytes = chunk.codeBytes; chunk.generateBundleGzipBytes = chunk.gzipBytes
    chunk.codeBytes = emitted.length; chunk.gzipBytes = gzipSync(emitted).length
  }
  await writeFile(file, JSON.stringify(graph, null, 2) + '\n'); graphs[label] = graph
}
const totals = (graph, result, allCodeKey, allGzipKey) => {
  result.initialStaticCodeBytes = result.initialStaticFiles.reduce((n, file) => n + graph[file].codeBytes, 0)
  result.initialStaticGzipBytes = result.initialStaticFiles.reduce((n, file) => n + graph[file].gzipBytes, 0)
  result[allCodeKey] = Object.values(graph).reduce((n, chunk) => n + chunk.codeBytes, 0)
  result[allGzipKey] = Object.values(graph).reduce((n, chunk) => n + chunk.gzipBytes, 0)
}
for (const [filename, beforeLabel, afterLabel, beforeKey, afterKey, allCodeKey, allGzipKey] of [
  ['build-summary', 'before', 'metadata', 'before', 'metadata', 'allCodeBytes', 'allGzipBytes'],
  ['launcher-build-summary', 'metadata', 'launcher', 'before', 'after', 'allMainGraphCodeBytes', 'allMainGraphGzipBytes'],
]) {
  const file = path.join(evidence, `${filename}.json`), summary = JSON.parse(await readFile(file, 'utf8'))
  await copyFile(file, path.join(evidence, `${filename}.generatebundle.json`))
  totals(graphs[beforeLabel], summary[beforeKey], allCodeKey, allGzipKey); totals(graphs[afterLabel], summary[afterKey], allCodeKey, allGzipKey)
  for (const key of Object.keys(summary.delta)) summary.delta[key] = summary[afterKey][key] - summary[beforeKey][key]
  summary.sizeAccounting = 'Final emitted files read after build completes. Original generateBundle-hook counts retained separately; finalization slightly changes code. gzip is sum of independently gzipSync-compressed final files.'
  await writeFile(file, JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({stage:filename,before:summary[beforeKey].initialStaticCodeBytes,after:summary[afterKey].initialStaticCodeBytes,delta:summary.delta},null,2))
}
