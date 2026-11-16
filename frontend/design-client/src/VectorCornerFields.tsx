import { edit_vector_corners_json } from './generated/design-kernel/design_kernel'
import { DraftInput } from './DraftInput'
import { UnitNumberField } from './UnitNumberField'
import type { DesignNode, VectorGeometry } from './model'
import { usePropertyText } from './property-interface-messages'

export function VectorCornerFields({ geometry, styleScale, styleDescription, update }: {
  geometry: VectorGeometry
  styleScale: number
  styleDescription?: string
  update: (apply: (node: DesignNode) => void, label?: string) => void
}) {
  const { tr } = usePropertyText()
  const source = geometry.cornerSource!
  const scale = Math.min(...source.scale) * styleScale
  const mixed = source.radii.some(value => value !== source.radii[0])
  const apply = (value: number, index?: number) => update(node => {
    const geometry = node.vectorGeometry
    const current = geometry?.cornerSource
    if (!geometry || !current) return
    const radius = value / (Math.min(...current.scale) * styleScale)
    const radii = current.radii.map((old, i) => index === undefined || index === i ? radius : old)
    node.vectorGeometry = JSON.parse(edit_vector_corners_json(
      JSON.stringify(geometry), Float64Array.from(radii), current.smoothing,
    )) as VectorGeometry
  }, '修改矢量圆角')

  return <div className="vector-corner-fields">
    {mixed ? <label className="labeled-select">{tr('圆角')}
      <DraftInput aria-label={tr('圆角')} placeholder={tr('混合')} value=""
        validate={value => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e7 * scale}
        onCommit={value => apply(Number(value))}/>
    </label> : <UnitNumberField label={tr('圆角')} historyLabel="圆角" diagnosticFamily={2}
      unitDescription={styleDescription} unit="length" unitScale={scale} value={source.radii[0]}
      min={0} max={1e7} onChange={value => apply(value * scale)}/>}
    {source.radii.length === 4 && <details>
      <summary>{tr('独立圆角')}</summary>
      <div className="field-grid">
        {source.radii.map((radius, index) => <UnitNumberField
          key={source.network.vertices[index].id} label={`${tr('顶点圆角')} ${index + 1}`}
          historyLabel="顶点圆角" diagnosticFamily={2} unit="length" value={radius}
          min={0} max={1e7} unitScale={scale} onChange={value => apply(value * scale, index)}/>)}
      </div>
    </details>}
  </div>
}
