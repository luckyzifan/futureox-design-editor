/**
 * Issue #1263 host-face loading. Production WASM/PNG rendering never reads an
 * installed font implicitly: a host (desktop `fonts.list`/`fonts.read` or the
 * web `queryLocalFonts` picker) reads a real face, this module matches it to
 * the document's authored source names by exact family + style or PostScript
 * name, and the bytes are installed into `document.fonts`. Canvas, PNG/WASM
 * export and native export then all read the same document font table.
 *
 * Matching is deliberately narrow: a digest-qualified source needs the exact
 * SHA-1; a name-only source needs an exact family/style identity. A nearest
 * static weight is a suggestion, never an automatic binding.
 */
import type { DesignDocument } from './model'
import { fontMatchKey, type FontResource } from './font-matching'
import { catalogEntryFor, resolveListedFace, type FontFaceInfo } from './font-catalog'
import { unmatchedEditableSourceFontRequests } from './font-management'

export type HostFontFace = FontFaceInfo & { id: string; index: number }

export type HostFontEntry = { id: string; resource: FontResource }

export type HostFontMatch = {
  /** Keyed by `fontMatchKey(name, digest)`, exactly what `matchSourceFontsInDocument` consumes. */
  matched: Map<string, HostFontEntry>
  /** Source names that no installed face identifies. */
  missing: string[]
  /** Every installed resource, so callers can pre-check the 32-resource limit. */
  loaded: Map<string, HostFontEntry>
}

export function resourceBytes(resource: FontResource) {
  return Uint8Array.from(atob(resource.data), c => c.charCodeAt(0))
}

/** Document font id: SHA-256 of the exact face bytes plus the face index. */
export async function resourceId(resource: FontResource) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', resourceBytes(resource)))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') + `-${resource.index || 0}`
}

/** FIG / Sketch source digest. A family name is never a digest. */
export async function resourceSha1(resource: FontResource) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', resourceBytes(resource)))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

const fold = (value: string) => value.normalize('NFKC').replace(/[\s_-]+/g, '').toLowerCase()

/**
 * Resolve every unmatched authored source name against a host catalog.
 * Kept in one place so the desktop picker, tests and any future import hook
 * use the same candidates, digest checks and 32-resource ceiling.
 */
export async function matchHostSourceFonts<T extends HostFontFace>(
  document: DesignDocument,
  faces: readonly T[],
  read: (face: T) => Promise<FontResource>,
  limits: { maxResources?: number } = {},
): Promise<HostFontMatch> {
  const maxResources = limits.maxResources ?? 32
  const requests = unmatchedEditableSourceFontRequests(document)
  const matched = new Map<string, HostFontEntry>()
  const missing: string[] = []
  const loaded = new Map<string, HostFontEntry>()
  const facesById = new Map<string, HostFontEntry>()
  const seen = new Set<string>()
  for (const source of requests) {
    const key = fontMatchKey(source.name, source.digest)
    if (seen.has(key)) continue
    seen.add(key)
    const family = catalogEntryFor(source.name)?.entry.family
    const preferred = resolveListedFace(source.name, faces)
    const sameFamily = family
      ? faces.filter(face => fold(face.family) === fold(family))
      : []
    const candidates = source.digest
      ? [...(preferred ? [preferred] : []), ...sameFamily.filter(face => face !== preferred)].slice(0, 8)
      : preferred ? [preferred] : []
    if (!candidates.length) {
      missing.push(source.digest ? `${source.name} 摘要 ${source.digest}` : source.name)
      continue
    }
    let entry: HostFontEntry | undefined
    for (const face of candidates) {
      let cached = facesById.get(face.id)
      if (!cached) {
        const resource = await read(face)
        const id = await resourceId(resource)
        cached = loaded.get(id)
        if (!cached) {
          // Admission allows 32 resources. Retain at most that many plus the
          // single face currently being identified; aliases reuse bytes.
          if (loaded.size >= maxResources) throw Error('文档最多支持 32 个字体资源；请先缩小原字体匹配范围')
          cached = { id, resource }
          loaded.set(id, cached)
        }
        facesById.set(face.id, cached)
      }
      if (!source.digest || await resourceSha1(cached.resource) === source.digest) {
        entry = cached
        break
      }
    }
    if (!entry) {
      missing.push(source.digest ? `${source.name} 摘要 ${source.digest}` : source.name)
      continue
    }
    matched.set(key, entry)
  }
  return { matched, missing, loaded }
}