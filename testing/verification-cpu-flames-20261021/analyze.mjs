import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const home = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(home, '../..')
let output = home, runsRoot = path.join(root, 'testing/verification-sharp-sequential-20261021'), assetsRoot = root, runPrefix = 'default-current', requestedStages, requestedThreads, fixtures = ['117', 'fig']
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (flag === '--help') {
    console.log('node analyze.mjs [--runs-root DIR] [--assets-root REPO_RELATIVE_ASSET_ROOT] [--out-dir DIR] [--run-prefix default-current] [--fixtures 117,fig] [--threads renderer,render-worker] [--stages continuous-wheel[,other-stage]]'); process.exit(0)
  }
  if (!['--runs-root', '--assets-root', '--out-dir', '--run-prefix', '--stages', '--fixtures', '--threads'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Unknown or incomplete argument: ' + flag)
  const value = args[++index]
  if (flag === '--runs-root') runsRoot = path.resolve(value)
  if (flag === '--assets-root') assetsRoot = path.resolve(value)
  if (flag === '--out-dir') output = path.resolve(value)
  if (flag === '--run-prefix') { if (!/^[a-z0-9-]+$/.test(value)) throw Error('Invalid run prefix'); runPrefix = value }
  if (flag === '--fixtures') {
    fixtures = value.split(',')
    if (!fixtures.length || fixtures.some(name => !['117', 'fig'].includes(name)) || new Set(fixtures).size !== fixtures.length)
      throw Error('Fixtures must be a unique selection of 117,fig')
  }
  if (flag === '--threads') {
    requestedThreads = value.split(',')
    if (requestedThreads.some(name => !['renderer', 'render-worker'].includes(name)) || new Set(requestedThreads).size !== requestedThreads.length)
      throw Error('Threads must be a unique selection of renderer,render-worker')
  }
  if (flag === '--stages') {
    requestedStages = value.split(',')
    if (requestedStages.some(stage => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stage)) || new Set(requestedStages).size !== requestedStages.length)
      throw Error('Stages must be unique comma-separated stage file prefixes')
  }
}
await mkdir(output, { recursive: true })
const require = createRequire(path.join(root, 'frontend/design-client/package.json'))
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')
const digest = value => createHash('sha256').update(value).digest('hex')
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const round = value => Number(value.toFixed(3))
const displayURL = value => {
  if (!value.startsWith('file:') && !path.isAbsolute(value)) return value
  try {
    const local = value.startsWith('file:') ? fileURLToPath(value) : value, relative = path.relative(root, local)
    return relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? 'repo:' + relative.replaceAll(path.sep, '/') : 'file:' + path.basename(local)
  } catch { return 'file:(unresolved)' }
}
const maps = new Map(), mapProofs = new Map(), summaries = [], sections = [], excludedTargets = []
const renderingFocus = new Set(['sequentialViewport', 'sequentialRejected', 'planSequentialDisplay', 'checkFrameCurrent',
  'abortFrameAndReleaseFilterScratch', 'reclaimScratch', 'certifyExactImageRange', 'uploadLinear', 'imageFor',
  'renderAttempt', 'sanitizeFields', 'plan', 'kernelLayout', 'resolve_components', 'translationOnlyChanges', 'validateDocument', 'detachMissing'])
const jobs = requestedStages ? fixtures.flatMap(fixture => requestedStages.map(stage => [fixture, stage])) :
  [['117', 'extended-continuous-wheel'], ['fig', 'extended-continuous-wheel'], ['fig', 'extended-property-x'], ['fig', 'extended-undo-edit']].filter(([fixture]) => fixtures.includes(fixture))
const basename = value => {
  try { return path.posix.basename(new URL(value).pathname) } catch { return path.posix.basename(value || '') }
}
const assetPath = value => {
  if (typeof value !== 'string' || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').some(part => part === '..' || part === '.'))
    throw Error('Unsafe runtime asset manifest key')
  return value.includes('/') ? value : 'frontend/design-desktop/dist/renderer/assets/' + value
}
function profiledTarget(row, index, stage) {
  const metadata = row && typeof row === 'object' && Object.hasOwn(row, 'target') ? row : null
  const target = metadata ? metadata.target : row
  let info, thread
  if (target === 'renderer') { info = { type: 'page', url: '' }; thread = 'renderer' }
  else if (target && typeof target === 'object' && typeof target.type === 'string' && typeof target.url === 'string') {
    info = { type: target.type, url: displayURL(target.url) }
    if (target.type === 'page') thread = 'renderer'
    else if (target.type === 'worker' && /^render-worker(?:[-.]|$)/.test(basename(target.url))) thread = 'render-worker'
    else if (['worker', 'shared_worker', 'service_worker'].includes(target.type)) thread = target.type + '-' + index
    else throw Error('Unsupported actual CPU profile target type: ' + target.type)
  } else throw Error('CPU profile has no actual renderer/worker target identity at index ' + index)
  const file = metadata?.file ?? `${stage}-${index}.cpuprofile`
  if (typeof file !== 'string' || path.basename(file) !== file || !/^[a-z0-9-]+-[0-9]+\.cpuprofile$/.test(file)) throw Error('Unsafe CPU profile filename')
  return { index, file, thread, info, startedAt: metadata?.startedAt ?? null, stopCommandAt: metadata?.stopCommandAt ?? null,
    stoppedAt: metadata?.stoppedAt ?? null, sourceURLs: metadata?.sourceURLs?.map(displayURL) ?? null }
}

function profilingProvenance(run) {
  if (run.extended?.cpuProfiling === true) return { kind: 'extended-cdp', actualExtendedCpuProfiling: true,
    reportProfile: run.profile ?? null, traceBoundary: null,
    scope: 'Extended profiler-instrumented operation window; not a clean latency benchmark.' }
  const boundary = run.cpuProfileTraceBoundary
  if (run.profile !== true || !boundary || !Number.isFinite(boundary.startAt) || !Number.isFinite(boundary.endAt) || boundary.endAt < boundary.startAt)
    throw Error('Actual CPU profiling provenance/trace boundary missing')
  return { kind: 'sharp-motion-cdp', actualExtendedCpuProfiling: false, reportProfile: true,
    traceBoundary: { startAt: boundary.startAt, endAt: boundary.endAt, interrupted: boundary.interrupted === true },
    scope: 'Profiler start precedes the native motion trace and stop follows it. Samples cover the whole recorded profile, including the surrounding profiler window. Epoch trace timestamps are not guessed into the CDP monotonic sample clock. Not a clean latency benchmark.' }
}

function drawSvg(tree, title) {
  let depth = 0
  const measure = (node, level) => { depth = Math.max(depth, level); for (const child of node.children.values()) measure(child, level + 1) }
  measure(tree, 0)
  const width = 1600, rowHeight = 18, rects = []
  const draw = (node, x, span, level) => {
    if (span < 0.5) return
    const frame = node.frame, label = frame?.name || title, y = (depth - level) * rowHeight
    const hue = [...label].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 50, 0)
    const color = label === '(garbage collector)' ? '#be92d0' : frame?.wasm ? '#e98476' : `hsl(${hue + 8} 80% 72%)`
    const location = frame?.original ? `${frame.original.source}:${frame.original.line}:${frame.original.column}` : ''
    const compiled = frame ? `${frame.compiledURL}:${frame.compiledLine}:${frame.compiledColumn}` : ''
    rects.push(`<g><title>${escape(label)} — ${node.ms.toFixed(3)} ms cumulative active samples\n${escape(location)}\n${escape(compiled)}</title><rect x="${x.toFixed(3)}" y="${y}" width="${Math.max(0, span - 0.3).toFixed(3)}" height="17" fill="${color}"/><text x="${(x + 2).toFixed(3)}" y="${y + 12}" font-size="10">${escape(label.slice(0, Math.max(0, Math.floor((span - 4) / 6))))}</text></g>`)
    let next = x
    for (const child of [...node.children.values()].sort((a, b) => b.ms - a.ms)) {
      const size = span * child.ms / node.ms
      draw(child, next, size, level + 1); next += size
    }
  }
  draw(tree, 0, width, 0)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${(depth + 1) * rowHeight}" viewBox="0 0 ${width} ${(depth + 1) * rowHeight}" style="font-family:monospace"><title>${escape(title)} — timeDeltas weighted active CPU stacks; not a timeline</title>${rects.join('')}</svg>`
}

for (const [fixture, stage] of jobs) {
  const directory = path.join(runsRoot, `${runPrefix}-${fixture}`)
  const artifactsRaw = await readFile(path.join(directory, 'runtime-artifacts.json'))
  const identities = JSON.parse(artifactsRaw).artifacts
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) throw Error('Runtime asset hash manifest missing')
  const targetsRaw = await readFile(path.join(directory, `${stage}-targets.json`)), targets = JSON.parse(targetsRaw)
  const resultRaw = await readFile(path.join(directory, 'results.json')), run = JSON.parse(resultRaw)
  if (!Array.isArray(targets) || !targets.length) throw Error('Actual CPU profile targets missing')
  const provenance = profilingProvenance(run), profiledTargets = targets.map((row, index) => profiledTarget(row, index, stage))
  if (profiledTargets.filter(target => target.thread === 'renderer').length !== 1) throw Error('Expected exactly one actual main renderer profile')
  const roleCounts = new Map()
  for (const target of profiledTargets) {
    const { file } = target, raw = await readFile(path.join(directory, file)), profile = JSON.parse(raw)
    if (requestedThreads && !requestedThreads.includes(target.thread)) {
      excludedTargets.push({ fixture, stage, thread: target.thread, file, profileSha256: digest(raw),
        reason: 'Explicit thread selection; not included in timing or flame widths.',
        negativeTimeDeltas: profile.timeDeltas.flatMap((deltaUs, sampleIndex) => deltaUs < 0 ? [{ sampleIndex, deltaUs }] : []) })
      continue
    }
    if (profile.samples.length !== profile.timeDeltas.length) throw Error('Sample/delta length mismatch')
    const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map(), frames = new Map()
    for (const node of profile.nodes) for (const id of node.children || []) {
      if (parents.has(id)) throw Error('Profile is not a call tree')
      parents.set(id, node.id)
    }
    for (const node of profile.nodes) {
      const call = node.callFrame, matches = Object.keys(identities).filter(file => path.posix.basename(file) === basename(call.url))
      if (matches.length > 1) throw Error('Ambiguous runtime asset basename: ' + basename(call.url))
      const asset = matches[0]
      let original = null
      if (asset && identities[asset + '.map']) {
        const relativeAsset = assetPath(asset), cacheKey = `${relativeAsset}|${identities[asset]}|${identities[asset + '.map']}`
        if (!maps.has(cacheKey)) {
          for (const file of [asset, asset + '.map']) {
            const relativeFile = assetPath(file)
            if (digest(await readFile(path.join(assetsRoot, relativeFile))) !== identities[file]) throw Error('Runtime/source-map hash mismatch: ' + relativeFile)
            if (mapProofs.has(relativeFile) && mapProofs.get(relativeFile) !== identities[file]) throw Error('Mixed runtime asset identities in one analysis: ' + relativeFile)
            mapProofs.set(relativeFile, identities[file])
          }
          maps.set(cacheKey, new TraceMap(JSON.parse(await readFile(path.join(assetsRoot, assetPath(asset + '.map'))))))
        }
        if (call.lineNumber >= 0) {
          const mapped = originalPositionFor(maps.get(cacheKey), { line: call.lineNumber + 1, column: call.columnNumber })
          if (mapped.source) original = { source: mapped.source, line: mapped.line, column: mapped.column, name: mapped.name }
        }
      }
      const runtimeName = call.functionName || '(anonymous)', wasm = runtimeName.includes('wasm-function[') || (call.url || '').startsWith('wasm:')
      frames.set(node.id, { name: original?.name || runtimeName, runtimeName, compiledURL: displayURL(call.url),
        compiledLine: call.lineNumber + 1, compiledColumn: call.columnNumber + 1, original, wasm,
        key: `${runtimeName}|${call.url}|${call.lineNumber}|${call.columnNumber}` })
    }
    const self = new Map(), inclusive = new Map(), nodeInclusive = new Map(), stacks = new Map()
    const tree = { ms: 0, children: new Map() }
    let total = 0, idle = 0, program = 0, gc = 0, wasm = 0
    const stackOf = id => {
      if (stacks.has(id)) return stacks.get(id)
      const chain = [], seen = new Set()
      while (id !== undefined && nodes.has(id)) { if (seen.has(id)) throw Error('Call-tree cycle'); seen.add(id); chain.unshift(id); id = parents.get(id) }
      stacks.set(chain.at(-1), chain); return chain
    }
    const add = (map, frame, ms) => { const row = map.get(frame.key) || { ...frame, ms: 0 }; row.ms += ms; map.set(frame.key, row) }
    for (let index = 0; index < profile.samples.length; index++) {
      const id = profile.samples[index], ms = profile.timeDeltas[index] / 1000, frame = frames.get(id)
      if (!frame || !Number.isFinite(ms) || ms < 0) throw Error('Invalid sample/delta')
      total += ms; add(self, frame, ms)
      if (frame.runtimeName === '(idle)') { idle += ms; continue }
      if (['(program)', '(root)'].includes(frame.runtimeName)) { program += ms; continue }
      if (frame.runtimeName === '(garbage collector)') gc += ms
      if (frame.wasm) wasm += ms
      tree.ms += ms
      let branch = tree
      const seen = new Set()
      for (const key of stackOf(id)) {
        const item = frames.get(key)
        nodeInclusive.set(key, (nodeInclusive.get(key) || 0) + ms)
        if (item.runtimeName === '(root)') continue
        if (!seen.has(item.key)) { add(inclusive, item, ms); seen.add(item.key) }
        if (!branch.children.has(item.key)) branch.children.set(item.key, { frame: item, ms: 0, children: new Map() })
        branch = branch.children.get(item.key); branch.ms += ms
      }
    }
    const ranked = map => [...map.values()].filter(frame => !['(root)', '(idle)', '(program)'].includes(frame.runtimeName)).sort((a, b) => b.ms - a.ms).map(({ key, ...frame }) => ({ ...frame, ms: round(frame.ms) }))
    const focused = []
    for (const node of profile.nodes) {
      const frame = frames.get(node.id), source = frame.original?.source || ''
      if ((frame.name === 'allParents' || renderingFocus.has(frame.name) || source.endsWith('desktop-session.ts') && [213, 214, 216, 226].includes(frame.original.line)) && nodeInclusive.get(node.id)) {
        let selfMs = 0
        for (let i = 0; i < profile.samples.length; i++) if (profile.samples[i] === node.id) selfMs += profile.timeDeltas[i] / 1000
        focused.push({ selfMs: round(selfMs), inclusiveMs: round(nodeInclusive.get(node.id)), stack: stackOf(node.id).map(id => { const { key, ...frame } = frames.get(id); return frame }) })
      }
    }
    const count = (roleCounts.get(target.thread) ?? 0) + 1; roleCounts.set(target.thread, count)
    const label = target.thread === 'renderer' ? 'main renderer' : target.thread
    const suffix = count > 1 ? '-' + target.index : ''
    const title = `${fixture} · ${stage} · ${label}${suffix}`
    const slug = `${fixture}-${stage.replace('extended-', '')}-${target.thread}${suffix}`
    const svg = drawSvg(tree, title); await writeFile(path.join(output, slug + '.svg'), svg)
    const summary = { fixture, stage, thread: target.thread, targetIndex: target.index, targetInfo: target.info,
      profileTargetMetadata: { startedAt: target.startedAt, stopCommandAt: target.stopCommandAt, stoppedAt: target.stoppedAt, sourceURLs: target.sourceURLs },
      profile: path.relative(root, path.join(directory, file)), profileSha256: digest(raw), targetProofSha256: digest(targetsRaw), artifactManifestSha256: digest(artifactsRaw), resultSha256: digest(resultRaw),
      reportSamplingFlag: run.sampling ?? null, actualExtendedCpuProfiling: provenance.actualExtendedCpuProfiling,
      profilingProvenance: provenance, actualRenderWorkerProfilePresent: profiledTargets.some(row => row.thread === 'render-worker'),
      runMode: run.mode ?? null, latencyTimingComparable: run.latencyTimingComparable ?? null,
      samples: profile.samples.length, wallMs: round((profile.endTime - profile.startTime) / 1000), sampledMs: round(total), activeMs: round(tree.ms), idleMs: round(idle), programUnattributedMs: round(program), gcMs: round(gc), wasmSelfMs: round(wasm),
      unsampledWallRemainderMs: round((profile.endTime - profile.startTime) / 1000 - total),
      topSelf: ranked(self).slice(0, 25), topInclusive: ranked(inclusive).slice(0, 30), focusedStacks: focused, svg: slug + '.svg' }
    summaries.push(summary)
    sections.push(`<section><h2>${escape(title)}</h2><p>${summary.samples} samples · sampled ${summary.sampledMs} ms · active ${summary.activeMs} ms · idle ${summary.idleMs} ms · program/unattributed ${summary.programUnattributedMs} ms · GC ${summary.gcMs} ms (included in active). Only active stacks below; width is cumulative sample weight, not chronological time.</p><div class="chart">${svg}</div><details><summary>Top self time and exact locations</summary><table><tr><th>Frame</th><th>Self ms</th><th>Source-map position (line 1-based / column 0-based)</th><th>Compiled URL (line/column 1-based)</th></tr>${summary.topSelf.map(row => `<tr><td>${escape(row.name)}</td><td>${row.ms}</td><td>${escape(row.original ? `${row.original.source}:${row.original.line}:${row.original.column}` : 'unresolved')}</td><td>${escape(`${row.compiledURL}:${row.compiledLine}:${row.compiledColumn}`)}</td></tr>`).join('')}</table></details></section>`)
  }
}
const result = { inputs: { runsRoot: path.relative(root, runsRoot), assetsRoot: path.relative(root, assetsRoot), runPrefix, stages: requestedStages ?? null, fixtures, threads: requestedThreads ?? null }, excludedTargets, method: 'Actual CDP samples[i] weighted by timeDeltas[i]/1000 milliseconds; self groups identical runtime frames, inclusive rankings count each identical frame at most once per sample to avoid recursive double counting. SVG preserves the sampled calling stack.',
  limitations: ['Every profile requires actual extended.cpuProfiling=true or sharp report.profile=true with a recorded trace boundary; all timing is profiler-instrumented, not a clean latency benchmark.', 'Targets are labeled only by their actual recorded renderer/TargetInfo metadata. A worker is named render-worker only when its recorded worker URL names that module; other workers retain their type/index. Missing render-worker coverage is explicit.', 'Only recorded target isolates are sampled; unsampled preparation/native/GPU processes are outside this record.', 'Idle is not CPU computation and is not evidence of GPU-only waiting; (program) is unattributed, not classified as GPU time.', 'WASM indexes remain literal; no Rust symbols are inferred or imported.', 'Main and worker start/stop windows differ and must not be added together as wall latency.', 'The complete CDP profile is analyzed; the epoch-clock native trace boundary is retained without inventing a conversion to the monotonic CDP sample clock.', 'SVG width normalizes active samples only; idle/program weights remain explicit in the summary. This is a flamegraph, not a timeline.', 'Source-map locations describe the hash-matched captured build, not necessarily subsequent checkout edits.'],
  verifiedJavaScriptAndSourceMaps: Object.fromEntries(mapProofs), profiles: summaries }
await writeFile(path.join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n')
await writeFile(path.join(output, 'flamegraphs.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>117 / FIG — actual sampled CPU flamegraphs</title><style>body{font:14px system-ui;margin:24px;background:#f6f6f4;color:#222}section{padding:16px;background:white;margin:20px 0;border:1px solid #ddd}.chart{overflow:auto;max-height:650px}table{border-collapse:collapse;font:12px monospace}td,th{padding:5px;border-bottom:1px solid #ddd;text-align:left}p{line-height:1.5}</style><h1>真实 Electron CPU 采样火焰图</h1><p>117 / FIG ${escape(runPrefix)} release。图来自真实 .cpuprofile 的 timeDeltas 加权调用栈，未使用阶段耗时生成色块。已验证实际CPU采样来源（extended.cpuProfiling 或 sharp profile + trace boundary）；不能把这些采样段当无 profiler 延迟基准。主renderer与实际记录的Worker分开，Worker类型来自TargetInfo而非序号猜测；idle / program 不画成活动计算。完整profile窗口可略超出原生输入trace，摘要保留边界，不虚构时钟映射。悬停查看帧、权重与精确位置；WASM保留真实索引，不猜Rust符号。</p>${sections.join('')}</html>`)
console.log(JSON.stringify(summaries.map(row => ({ fixture: row.fixture, stage: row.stage, thread: row.thread, sampledMs: row.sampledMs, activeMs: row.activeMs, idleMs: row.idleMs, topSelf: row.topSelf.slice(0, 4) })), null, 2))
