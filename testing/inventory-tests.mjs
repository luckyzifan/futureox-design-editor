#!/usr/bin/env node
// Static file inventory only. Does not execute tests or infer assertion coverage.
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, basename, relative, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (process.argv.length > 2) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('node testing/inventory-tests.mjs > /path/to/test-inventory.json')
    console.log('Inventories tracked + non-ignored files, or source folders in an exported checkout. Never runs tests.')
    process.exit(0)
  }
  console.error('Unknown argument; use --help.')
  process.exit(2)
}
let paths, revision = null, selection
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort()
  selection = 'Git tracked and non-ignored untracked working-tree files; contents may differ from HEAD.'
} catch {
  const excluded = new Set(['.git', 'node_modules', 'target', 'dist', 'release', 'generated', '__pycache__', 'test-results', 'playwright-report'])
  paths = []
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(item.name)) continue
      const name = join(directory, item.name)
      if (item.isDirectory()) await walk(name)
      else if (item.isFile()) paths.push(relative(root, name).replaceAll('\\', '/'))
    }
  }
  await walk(root)
  paths.sort()
  selection = 'Exported source-tree traversal, excluding dependencies/build output; symlinks not followed.'
}
const entries = [], fixtures = [], packageScripts = [], unreadable = []
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.py', '.sh', '.cpp'])
for (const path of paths) {
  if (/\/(?:fixtures|fidelity|color-fixtures|fonts|oracles)\//.test(path) || /(?:^|\/)[^/]*fixtures?\.(?:ts|tsx|json)$/.test(path)) fixtures.push(path)
  if (!codeExtensions.has(extname(path)) && basename(path) !== 'package.json') continue
  let source
  try { source = await readFile(join(root, path), 'utf8') } catch { unreadable.push(path); continue }
  if (basename(path) === 'package.json') {
    const pkg = JSON.parse(source)
    for (const [name, command] of Object.entries(pkg.scripts ?? {}))
      if (/^(?:test|check|verify|benchmark)(?::|$)/.test(name)) packageScripts.push({ path, name, command })
    continue
  }
  const frameworks = []
  if (/\bfrom\s*['"]vitest['"]/.test(source)) frameworks.push('vitest')
  if (/(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()['"]node:test['"]/.test(source)) frameworks.push('node:test')
  if (/(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()['"]bun:test['"]/.test(source)) frameworks.push('bun:test')
  if (/\bfrom\s*['"]@playwright\/test['"]/.test(source)) frameworks.push('playwright-script')
  if (extname(path) === '.rs' && /#\[(?:tokio::)?test(?:\]|\()/.test(source)) frameworks.push('rust-tests')
  if (extname(path) === '.py' && /unittest\.TestCase/.test(source)) frameworks.push('python-unittest')
  const categories = []
  if (/\.(?:test|spec)\.(?:[cm]?js|tsx?)$/.test(path) || /^test_.*\.py$/.test(basename(path))) categories.push('named-test-file')
  if (/^design-studio\/crates\/[^/]+\/tests\/[^/]+\.rs$/.test(path)) categories.push('rust-integration')
  if (/\/benches\//.test(path) || /^benchmark(?:[-_.]|$)/.test(basename(path))) categories.push('benchmark')
  if ((/\/scripts\//.test(path) || !path.includes('/')) && /^(?:check|test|verify|smoke)(?:[-_.]|$)/.test(basename(path))) categories.push('script-entrypoint')
  if (!categories.length && !frameworks.length) continue
  entries.push({ path, scope: path.startsWith('vendor/') ? 'vendored' : 'project', categories, frameworks,
    bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'),
    hints: {
      absoluteHomePath: /\/(?:Users|home)\/[^\s/'"]+\//.test(source),
      generatedKernel: /generated\/design-kernel|public\/kernel|design_kernel_bg\.wasm/.test(source),
      explicitSkipOrOnly: /\b(?:test|it|describe)\.(?:skip|only|todo)\b|#\[ignore/.test(source),
      browserLaunch: /(?:chromium|firefox|webkit|electron)\.launch\s*\(/.test(source),
      sourceTextAssertion: /readFileSync|read_to_string|include_str!/.test(source),
    },
  })
}
const countBy = (items, values) => {
  const result = {}
  for (const item of items) for (const value of values(item)) result[value] = (result[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
const project = entries.filter(entry => entry.scope === 'project')
console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), baseRevision: revision,
  scope: selection,
  limitations: [
    'Counts are files or entrypoints, not executed tests, passed assertions, line coverage, or reviewed assertions.',
    'Framework/category/hint detection is static regex-based; a file can belong to multiple categories.',
    'Fixture listing does not prove ownership, redistribution rights, pixel correctness, or completeness.',
    'No dependency installation, compilation, browser/GPU launch, or secret scan is performed.',
  ],
  summary: { sourceFilesConsidered: paths.length, projectTestAndScriptFiles: project.length,
    frameworkFiles: countBy(project, entry => entry.frameworks), categoryFiles: countBy(project, entry => entry.categories),
    vendoredTestAndScriptFiles: entries.length - project.length, fixtureRelatedFiles: fixtures.length, packageTestScripts: packageScripts.length,
    unreadableCodeFiles: unreadable.length },
  packageScripts, entries, fixtureRelatedFiles: fixtures, unreadable,
}, null, 2))
if (unreadable.length) process.exitCode = 1
