import type { DesignDocument } from '../model'
import { worldMatrix } from '../geometry'
import { propertyUnits, hasProportionalStyleUnits } from '../property-units'
import { selectionMetric } from '../selection-properties'

/** Optional read-only Inspector projection, not an alternate authored model.
 * Never feed these numbers into node.update without converting local units. */
export function displayProperties(doc: DesignDocument, id: string) {
  const n = doc.nodes[id], units = propertyUnits(doc, id), similarity = hasProportionalStyleUnits(worldMatrix(doc, id))
  const geometry = { units: 'effective-document' as const,
    width: selectionMetric(n, 'width', doc, units), height: selectionMetric(n, 'height', doc, units) }
  if (!similarity) return { ...geometry, unsupported: [
    'Scalar font, stroke and effect distances are omitted for non-uniform or skewed world transforms: there is no unique proportional distance scale. Width/height are transformed local-axis lengths, not a world-axis AABB.',
  ] }
  return { ...geometry,
    ...(n.kind === 'text' ? { fontSize: n.fontSize * units.style } : {}),
    strokes: n.strokes.map(s => ({ id: s.id, width: s.width * units.style })),
    effects: n.effects.map(fx => ({ id: fx.id, kind: fx.kind,
      radius: fx.radius * units.style, x: fx.x * units.style, y: fx.y * units.style, spread: fx.spread * units.style,
      ...(fx.glass ? { glass: { depth: fx.glass.depth * units.style,
        ...(fx.glass.bevelSize === undefined ? {} : { bevelSize: fx.glass.bevelSize * units.style }) } } : {}),
    })),
    unsupported: ['This bounded projection omits mixed text-run sizes, stroke profiles/dashes, effect amount/texture/gradient fields, layout lengths and other Inspector controls. Read authored fields separately; they remain local units.'],
  }
}
