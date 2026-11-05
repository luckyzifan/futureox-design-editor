import { useState } from 'react'
import { UnitNumberField } from './UnitNumberField'
import type { DesignNode } from './model'

const cornerLabels = ['左上', '右上', '右下', '左下'] as const
export function radiiAreUniform(radii: readonly number[]) {
  return radii.length === 4 && radii.every(value => value === radii[0])
}
export function uniformRadii(value: number): [number, number, number, number] {
  return [value, value, value, value]
}

/** Figma Mac shows one corner-radius field until corners differ or the
 * independent-corners control is on. Smoothing stays with the rectangle. */
export function CornerRadiusFields({ nodeId, radii, tr, update, unitDescription, unitScale }: {
  nodeId: string
  radii: [number, number, number, number]
  tr: (text: string) => string
  update: (fn: (node: DesignNode) => void, label?: string) => void
  unitDescription?: string
  unitScale: number
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const expanded = expandedId === nodeId
  const independent = expanded || !radiiAreUniform(radii)
  return <>
    <div className="corner-radius-row">
      <h4>{tr('圆角')}</h4>
      <button type="button" className="corner-independence" aria-pressed={independent} aria-label={tr('独立圆角')} title={tr('独立圆角')}
        onClick={() => { if (radiiAreUniform(radii)) setExpandedId(expanded ? null : nodeId) }}>
        <span /><span /><span /><span />
      </button>
    </div>
    {independent ? <div className="field-grid">
      {radii.map((radius, index) => <UnitNumberField unitDescription={unitDescription} historyLabel={cornerLabels[index]} unit="length" diagnosticFamily={2} unitScale={unitScale}
        key={cornerLabels[index]} label={tr(cornerLabels[index])} value={radius} min={0}
        onChange={value => update(node => { node.radii[index] = value }, cornerLabels[index])} />)}
    </div> : <UnitNumberField unitDescription={unitDescription} historyLabel="圆角" unit="length" diagnosticFamily={2} unitScale={unitScale}
      label={tr('圆角')} value={radii[0]} min={0} onChange={value => update(node => { node.radii = uniformRadii(value) }, '圆角')} />}
  </>
}
