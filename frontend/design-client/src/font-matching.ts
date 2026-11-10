import { defaultTextStyle, type DesignDocument, type DesignNode } from './model'

export type FontResource = NonNullable<DesignDocument['fonts']>[string]
export type FontIdentity = { family: string; style: string; postscript: string }
export type FontSourceRecord = {
  style?: string
  runs?: Record<string, string>
  resolved?: string[]
  /** SHA-1 of the font file the source measured. A family name is not this. */
  digest?: string
  runDigests?: Record<string, string>
}
export type SourceFontRequest = { name: string; digest?: string }
/** Digest-qualified identities must not collapse onto a same-named different file. */
export function fontMatchKey(name: string, digest?: string) {
  return digest ? `${name}\0${digest}` : name
}
type Source = FontSourceRecord
export function sourceNameResolved(source: Source, name: string) {
  return !!source.resolved?.includes(name)
}
export function sourceFonts(document: DesignDocument, node: DesignNode): Source {
  const direct = document.designSystem?.fontSources?.[node.id]
  if (direct) return direct
  const metadata = document.designSystem?.sketchContainers?.nodeMetadata as Record<string, { bindings?: Record<string, unknown> }> | undefined
  const raw = metadata?.[node.id]?.bindings?.sketchSourceFonts
  if (typeof raw !== 'string') return {}
  try {
    const source = JSON.parse(raw)
    return source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  } catch { return {} }
}
export function unmatchedSourceFonts(document: DesignDocument, node: DesignNode): string[] {
  return [...new Set(unmatchedSourceFontRequests(document, node).map(request => request.name))]
}
export function unmatchedSourceFontRequests(document: DesignDocument, node: DesignNode): SourceFontRequest[] {
  const source = sourceFonts(document, node), requests: SourceFontRequest[] = []
  const font = node.textStyle?.fontId ?? 'default'
  if (typeof source.style === 'string' && font === 'default' && !sourceNameResolved(source, source.style))
    requests.push({ name: source.style, ...(source.digest ? { digest: source.digest } : {}) })
  for (const [index, name] of Object.entries(source.runs || {})) {
    const run = node.textRuns?.[Number(index)]
    const digest = source.runDigests?.[index]
    if (run && typeof name === 'string' && (run.fontId ?? font) === 'default' && !sourceNameResolved(source, name))
      requests.push({ name, ...(digest ? { digest } : {}) })
  }
  return requests
}
/** Before replacing a missing layer font, pin unresolved imported run faces to
 * their existing fallback. FIG runs can carry only a source identity, so leaving
 * fontId omitted would silently retarget them to the newly matched layer font. */
export function preserveUnmatchedSourceRuns(node: DesignNode, source: Source) {
  for (const [index, name] of Object.entries(source.runs || {})) {
    const run = node.textRuns?.[Number(index)]
    if (run && typeof name === 'string' && run.fontId === undefined) run.fontId = 'default'
  }
}
const normalize = (s: string) => s.normalize('NFKC').replace(/[\s_-]/g, '').toLowerCase()
/** Exact identity matching only. Ambiguous family names never pick a random weight. */
export function matchFont<T extends FontIdentity>(name: string, fonts: T[]): T | undefined {
  const key = normalize(name)
  const postscript = fonts.filter(f => f.postscript && normalize(f.postscript) === key)
  if (postscript.length === 1) return postscript[0]
  if (postscript.length) return undefined
  const full = fonts.filter(f => normalize(`${f.family} ${f.style}`) === key ||
    (/^(regular|normal|roman)$/i.test(f.style) && normalize(f.family) === key))
  return full.length === 1 ? full[0] : undefined
}
/** Install only real bytes, then replace still-unmatched references, preserving
 * per-run weight, size, colour and the user's explicitly assigned fonts. */
export function applyMatchedFonts(document: DesignDocument, matches: Map<string, { id: string; resource: FontResource }>) {
  let changed = 0
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'text') continue
    const source = sourceFonts(document, node), original = node.textStyle?.fontId ?? 'default'
    // Assign runs first: changing the layer font must not hide their fallback state.
    for (const [index, name] of Object.entries(source.runs || {})) {
      const run = node.textRuns?.[Number(index)]
      const match = lookupMatchedFont(matches, name, source.runDigests?.[index])
      if (run && match && (run.fontId ?? original) === 'default') {
        document.fonts = { ...document.fonts, [match.id]: match.resource }
        run.fontId = match.id; changed++
      }
    }
    const match = source.style && lookupMatchedFont(matches, source.style, source.digest)
    if (match && original === 'default') {
      preserveUnmatchedSourceRuns(node, source)
      document.fonts = { ...document.fonts, [match.id]: match.resource }
      node.textStyle = { ...defaultTextStyle(), ...node.textStyle, fontId: match.id }; changed++
    }
  }
  return changed
}
function lookupMatchedFont(matches: Map<string, { id: string; resource: FontResource }>, name: string, digest?: string) {
  if (digest) return matches.get(fontMatchKey(name, digest))
  return matches.get(name)
}
