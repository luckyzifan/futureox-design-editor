// Node strip-only TypeScript does not resolve extensionless relative imports,
// and it rejects TypeScript parameter properties. Node 26 removed the transform
// mode that used to accept them. test:render-diagnostics, test:render-contracts,
// and test:node-entries preload this module with --import.
//
// Resolution: when default resolution throws ERR_MODULE_NOT_FOUND, a relative
// specifier with no extension is mapped onto an existing .ts, .mts, .js, or
// .mjs file, in that order, and handed back to Node. .ts wins over a sibling
// .js. .tsx is not a Node strip-only extension. Missing files and bare
// specifiers stay unresolved.
//
// Parameter properties: Node's own loader throws while detecting the format, so
// the original source has to be lowered before nextLoad. Only the access
// modifiers are removed, and `this.name = name` is inserted after an opening
// `super(...)` when that call is the first statement, otherwise at the start of
// the constructor body. The rest of the file is unchanged. Production builds
// still compile the original TypeScript; this rewrite exists so the Node test
// entries can execute it.
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CANDIDATE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs']
const LOWERED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts'])
const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly'])
const REGEX_KEYWORDS = new Set(['return', 'throw', 'case', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'await', 'yield', 'new', 'else', 'do'])

function isIdentStart(char) {
  return char === '_' || char === '$' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
}
function isIdentPart(char) {
  return isIdentStart(char) || (char >= '0' && char <= '9')
}
function readIdent(source, index, end) {
  if (index >= end || !isIdentStart(source[index])) return index
  index++
  while (index < end && isIdentPart(source[index])) index++
  return index
}
function skipQuoted(source, index, end) {
  const quote = source[index]
  index++
  while (index < end) {
    if (source[index] === '\\') { index += 2; continue }
    if (source[index] === quote) return index + 1
    if (source[index] === '\n') return index
    index++
  }
  return index
}
function skipComment(source, index, end) {
  if (source[index + 1] === '/') {
    const next = source.indexOf('\n', index)
    return next < 0 || next >= end ? end : next
  }
  const next = source.indexOf('*/', index + 2)
  return next < 0 ? end : Math.min(end, next + 2)
}
function skipRegex(source, index, end) {
  index++
  let charClass = false
  while (index < end) {
    if (source[index] === '\\') { index += 2; continue }
    if (source[index] === '[' && !charClass) { charClass = true; index++; continue }
    if (source[index] === ']' && charClass) { charClass = false; index++; continue }
    if (source[index] === '/' && !charClass) {
      index++
      while (index < end && /[a-z]/i.test(source[index])) index++
      return index
    }
    if (source[index] === '\n') return index
    index++
  }
  return index
}
function skipTrivia(source, index, end) {
  while (index < end) {
    const char = source[index]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f') { index++; continue }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index, end)
      continue
    }
    break
  }
  return index
}
function skipBalanced(source, index, end, open, close) {
  if (source[index] !== open) return -1
  let depth = 0
  let regexOk = true
  while (index < end) {
    const char = source[index]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f') { index++; continue }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index, end)
      continue
    }
    if (char === '/' && regexOk) { index = skipRegex(source, index, end); regexOk = false; continue }
    if (char === "'" || char === '"') { index = skipQuoted(source, index, end); regexOk = false; continue }
    if (char === '`') { index = skipTemplate(source, index, end); regexOk = false; continue }
    if (isIdentStart(char)) {
      const next = readIdent(source, index, end)
      regexOk = REGEX_KEYWORDS.has(source.slice(index, next))
      index = next
      continue
    }
    if (char === '=' && source[index + 1] === '>') { regexOk = true; index += 2; continue }
    if (char === open) { depth++; regexOk = true; index++; continue }
    if (char === close) {
      depth--
      if (depth === 0) return index + 1
      regexOk = false
      index++
      continue
    }
    regexOk = char !== ')' && char !== ']' && char !== '}'
    index++
  }
  return -1
}
function skipTemplate(source, index, end) {
  index++
  while (index < end) {
    if (source[index] === '\\') { index += 2; continue }
    if (source[index] === '`') return index + 1
    if (source[index] === '$' && source[index + 1] === '{') {
      const next = skipBalanced(source, index + 1, end, '{', '}')
      index = next < 0 ? end : next
      continue
    }
    index++
  }
  return index
}
function skipDecorators(source, index, end) {
  while (index < end && source[index] === '@') {
    index++
    while (index < end && (isIdentPart(source[index]) || source[index] === '.')) index++
    index = skipTrivia(source, index, end)
    if (source[index] === '(') {
      const next = skipBalanced(source, index, end, '(', ')')
      if (next < 0) return index
      index = next
    }
    index = skipTrivia(source, index, end)
  }
  return index
}
function modifierPrefix(text) {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').trim()
  return cleaned.length > 0 && cleaned.split(/\s+/).every(part => MODIFIERS.has(part))
}
function propertyAt(source, start, end) {
  let index = skipDecorators(source, skipTrivia(source, start, end), end)
  index = skipTrivia(source, index, end)
  const modifierStart = index
  let saw = false
  while (index < end) {
    const next = readIdent(source, index, end)
    if (next === index || !MODIFIERS.has(source.slice(index, next))) break
    saw = true
    index = skipTrivia(source, next, end)
  }
  if (!saw) return null
  const nameStart = index
  const nameEnd = readIdent(source, index, end)
  if (nameEnd === nameStart || !modifierPrefix(source.slice(modifierStart, nameStart))) return null
  return { modifierStart, nameStart, name: source.slice(nameStart, nameEnd) }
}
function parameterProperties(source, start, end) {
  const found = []
  let index = start
  let paramStart = start
  let depth = 0
  let regexOk = true
  const consider = paramEnd => {
    const property = propertyAt(source, paramStart, paramEnd)
    if (property) found.push(property)
  }
  while (index < end) {
    const char = source[index]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f') { index++; continue }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index, end)
      continue
    }
    if (char === '/' && regexOk) { index = skipRegex(source, index, end); regexOk = false; continue }
    if (char === "'" || char === '"') { index = skipQuoted(source, index, end); regexOk = false; continue }
    if (char === '`') { index = skipTemplate(source, index, end); regexOk = false; continue }
    if (char === '(' || char === '[' || char === '{') { depth++; regexOk = true; index++; continue }
    if (char === ')' || char === ']' || char === '}') {
      if (depth > 0) depth--
      regexOk = false
      index++
      continue
    }
    if (char === ',' && depth === 0) {
      consider(index)
      index++
      paramStart = index
      regexOk = true
      continue
    }
    if (isIdentStart(char)) {
      const next = readIdent(source, index, end)
      regexOk = REGEX_KEYWORDS.has(source.slice(index, next))
      index = next
      continue
    }
    if (char === '=' && source[index + 1] === '>') { regexOk = true; index += 2; continue }
    regexOk = char !== '.' 
    index++
  }
  consider(end)
  return found
}
function assignmentIndex(source, bodyOpen) {
  let index = skipTrivia(source, bodyOpen + 1, source.length)
  const nameEnd = readIdent(source, index, source.length)
  if (source.slice(index, nameEnd) !== 'super') return bodyOpen + 1
  let cursor = skipTrivia(source, nameEnd, source.length)
  if (source[cursor] !== '(') return bodyOpen + 1
  cursor = skipBalanced(source, cursor, source.length, '(', ')')
  if (cursor < 0) return bodyOpen + 1
  cursor = skipTrivia(source, cursor, source.length)
  if (source[cursor] === ';') cursor++
  return cursor
}
function constructorEdits(source, index) {
  index = skipTrivia(source, index, source.length)
  if (source[index] === '<') {
    const next = skipBalanced(source, index, source.length, '<', '>')
    if (next < 0) return null
    index = skipTrivia(source, next, source.length)
  }
  if (source[index] !== '(') return null
  const close = skipBalanced(source, index, source.length, '(', ')')
  if (close < 0) return null
  const properties = parameterProperties(source, index + 1, close - 1)
  if (!properties.length) return null
  index = skipTrivia(source, close, source.length)
  const edits = properties.map(property => ({ start: property.modifierStart, end: property.nameStart, text: '' }))
  if (source[index] === '{') {
    const at = assignmentIndex(source, index)
    edits.push({ start: at, end: at, text: properties.map(property => `;this.${property.name}=${property.name}`).join('') + ';' })
    return edits
  }
  if (source[index] === ';') return edits
  return null
}

/** Strip parameter-property modifiers so Node's strip-only parser can load the file. */
export function lowerParameterProperties(source) {
  if (!source.includes('constructor')) return source
  const edits = []
  let index = 0
  const end = source.length
  let regexOk = true
  while (index < end) {
    const char = source[index]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f') { index++; continue }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index, end)
      continue
    }
    if (char === '/' && regexOk) { index = skipRegex(source, index, end); regexOk = false; continue }
    if (char === "'" || char === '"' || char === '`') {
      index = char === '`' ? skipTemplate(source, index, end) : skipQuoted(source, index, end)
      regexOk = false
      continue
    }
    if (isIdentStart(char)) {
      const next = readIdent(source, index, end)
      const word = source.slice(index, next)
      if (word === 'constructor') {
        const found = constructorEdits(source, next)
        if (found) edits.push(...found)
      }
      regexOk = REGEX_KEYWORDS.has(word)
      index = next
      continue
    }
    if (char === '=' && source[index + 1] === '>') { regexOk = true; index += 2; continue }
    regexOk = char !== ')' && char !== ']' && char !== '}' && char !== '.'
    index++
  }
  if (!edits.length) return source
  edits.sort((left, right) => right.start - left.start || right.end - left.end)
  let output = source
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  return output
}

function resolveExtensionless(specifier, parentURL) {
  for (const extension of CANDIDATE_EXTENSIONS) {
    const url = new URL(`${specifier}${extension}`, parentURL)
    if (url.protocol === 'file:' && existsSync(url)) return url.href
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL ||
        !specifier.startsWith('.') || extname(specifier)) throw error
      const href = resolveExtensionless(specifier, context.parentURL)
      if (!href) throw error
      return nextResolve(href, context)
    }
  },
  load(url, context, nextLoad) {
    let extension = ''
    try { extension = extname(fileURLToPath(url)) }
    catch { return nextLoad(url, context) }
    if (!LOWERED_EXTENSIONS.has(extension)) return nextLoad(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const lowered = lowerParameterProperties(source)
    // Format detection itself rejects parameter properties, so nextLoad cannot
    // see the original text. Unchanged files stay on Node's loader.
    if (lowered === source) return nextLoad(url, context)
    return { format: 'module-typescript', source: lowered, shortCircuit: true }
  },
})
