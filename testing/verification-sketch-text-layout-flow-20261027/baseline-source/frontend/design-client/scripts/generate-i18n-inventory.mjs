/** Candidate inventory, not a UI-completeness percentage. No source text is rewritten. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'rolldown/utils'
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(client, 'src')
const output = path.resolve(process.argv[2] || path.join(client, '../../docs/I18N_REMAINING_STRINGS_V1.json'))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const files = [], entries = []
function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name), stat = fs.statSync(absolute)
    if (stat.isDirectory()) { visit(absolute); continue }
    if (!/\.(tsx?|m?js)$/.test(name) || /\.(test|spec)\.|\.d\.ts$/.test(name) || name === 'interface-messages.ts') continue
    const relative = path.relative(client, absolute).replaceAll(path.sep, '/'), bytes = fs.readFileSync(absolute), text = bytes.toString('utf8')
    const parsed = parseSync(relative, text)
    if (parsed.errors.length) throw new Error(`Cannot inventory ${relative}: ${JSON.stringify(parsed.errors)}`)
    const startCount = entries.length
    function walk(node, parent) {
      if (!node || typeof node !== 'object') return
      const value = node.type === 'TemplateElement' ? node.value.cooked ?? node.value.raw
        : ['Literal', 'JSXText'].includes(node.type) ? node.value : null
      if (typeof value === 'string' && /\p{Script=Han}/u.test(value)) {
        const preceding = text.slice(0, node.start), line = preceding.split('\n').length
        entries.push({ file: relative, line, column: node.start - preceding.lastIndexOf('\n'),
          kind: node.type === 'JSXText' ? 'jsx-text' : parent?.type === 'JSXAttribute' ? 'jsx-attribute' : 'code-literal-or-template', text: value.trim() })
      }
      for (const [key, child] of Object.entries(node)) {
        if (['comments', 'tokens'].includes(key)) continue
        if (Array.isArray(child)) { for (const item of child) if (item?.type) walk(item, node) }
        else if (child?.type) walk(child, node)
      }
    }
    walk(parsed.program); files.push({ file: relative, sha256: sha256(bytes), candidates: entries.length - startCount })
  }
}
visit(sourceRoot)
const inventory = {
  format: 'futureox.i18n-source-candidates.v1', scope: 'Production src .ts/.tsx/.js/.mjs; excludes tests, declarations, comments and the localized interface-messages.ts catalog.',
  interpretation: 'Han-script literal candidates only, not all visible strings and not a translation-completion metric. Code literals can be authored document defaults, errors, identifiers, diagnostics or test/dev helpers. English-only untranslated text, runtime/host strings and interpolation meaning require manual review. Never bulk-translate authored names or stable protocol identifiers.',
  counts: { filesScanned: files.length, filesWithCandidates: files.filter(file => file.candidates).length, candidates: entries.length },
  sourceInventorySha256: sha256(JSON.stringify(files)), files, entries,
}
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n')
console.log(JSON.stringify(inventory.counts))
console.log(JSON.stringify(files.filter(file => file.candidates).sort((a, b) => b.candidates - a.candidates).slice(0, 15), null, 2))
