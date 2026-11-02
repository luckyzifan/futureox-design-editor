import { useEffect, useState } from 'react'
import { radiiUniform } from './corner-radius'
import { NumberField } from './fields'
import { MixedNumberField } from './MixedNumberField'
import { usePropertyText } from './property-interface-messages'
import { UnitNumberField } from './UnitNumberField'

const labels = ['左上', '右上', '右下', '左下'] as const
/** Visual order is top-left, top-right, bottom-left, bottom-right. */
const visualOrder = [0, 1, 3, 2] as const

export function CornerRadiusFields({ nodeId, radii, smoothing, scale, description, onRadii, onSmoothing }: {
  nodeId: string
  radii: [number, number, number, number]
  smoothing: number
  scale: number
  description?: string
  onRadii: (radii: [number, number, number, number]) => void
  onSmoothing: (smoothing: number) => void
}) {
  const { tr } = usePropertyText()
  const uniform = radiiUniform(radii)
  const [forNode, setForNode] = useState(nodeId)
  const [independent, setIndependent] = useState(!uniform)
  useEffect(() => {
    if (nodeId !== forNode) {
      setForNode(nodeId)
      setIndependent(!radiiUniform(radii))
      return
    }
    if (!radiiUniform(radii)) setIndependent(true)
  }, [nodeId, forNode, radii])
  const setAll = (value: number) => onRadii([value, value, value, value])
  return <>
    <div className="corner-radius-head">
      {!independent && (uniform
        ? <UnitNumberField unitDescription={description} historyLabel="圆角" unit="length" diagnosticFamily={2} unitScale={scale} label={tr('圆角')} value={radii[0]} min={0} onChange={setAll} />
        : <MixedNumberField unitDescription={description} historyLabel="圆角" diagnosticFamily={2} unit="length" label={tr('圆角')} value={undefined} min={0} max={1e6 * scale} onChange={value => setAll(value / (scale || 1))} />)}
      {independent && <span className="corner-radius-caption">{tr('圆角')}</span>}
      <button type="button" className="corner-independent" data-testid="corner-independent" aria-pressed={independent} aria-label={tr('独立圆角')} title={tr('独立圆角')}
        onClick={() => setIndependent(open => !open)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1" y="1" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1 4.5V2.2C1 1.5 1.5 1 2.2 1H4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
    {independent && <div className="field-grid">
      {visualOrder.map(index => <UnitNumberField key={labels[index]} unitDescription={description} historyLabel={labels[index]} unit="length" diagnosticFamily={2} unitScale={scale}
        label={tr(labels[index])} value={radii[index]} min={0}
        onChange={value => { const next: [number, number, number, number] = [radii[0], radii[1], radii[2], radii[3]]; next[index] = value; onRadii(next) }} />)}
    </div>}
    {(radii.some(radius => radius > 0) || smoothing > 0) && <NumberField historyLabel="圆角平滑 %" diagnosticFamily={2} unit="percent" label={tr('圆角平滑 %')} value={smoothing * 100} min={0} max={100}
      onChange={value => onSmoothing(value / 100)} />}
  </>
}
