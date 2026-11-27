import { selectedDocument } from './clipboard-core'
import { emptySystem } from './design-system'
import { cloneValue } from './draft'
import { validateDocument, type DesignDocument } from './model'

const fontBindings = ['sketchSourceFonts', 'sketchSourceStyleFontDescriptor'] as const
type SketchNodeMetadata = Record<string, { bindings?: Record<string, unknown> }>

/** Keep source font identities on the text nodes emitted by Sketch export. */
export function selectedSketchDocument(source: DesignDocument, nodeIds: string[], name: string) {
  const { document } = selectedDocument(source, nodeIds, name)
  const sourceSystem = source.designSystem
  if (!sourceSystem) return document
  const sourceMetadata = sourceSystem.sketchContainers?.nodeMetadata as SketchNodeMetadata | undefined
  for (const [id, exported] of Object.entries(document.nodes)) {
    // The projection reserves all source IDs when remapping a dependency.
    // An emitted text node with the same ID still refers to the source text.
    if (exported.kind !== 'text' || source.nodes[id]?.kind !== 'text') continue
    const sourceFont = sourceSystem.fontSources?.[id]
    const bindings: Record<string, string> = {}
    for (const key of fontBindings) {
      const value = sourceMetadata?.[id]?.bindings?.[key]
      if (typeof value === 'string') bindings[key] = value
    }
    const hasBindings = Object.keys(bindings).length > 0
    if (!sourceFont && !hasBindings) continue
    const system = document.designSystem ??= emptySystem()
    if (sourceFont) (system.fontSources ??= {})[id] = cloneValue(sourceFont)
    if (hasBindings) {
      const containers = system.sketchContainers ??= {}
      const metadata = (containers.nodeMetadata ??= {}) as SketchNodeMetadata
      const entry = metadata[id] ??= {}
      entry.bindings = { ...entry.bindings, ...bindings }
    }
  }
  return validateDocument(document)
}
