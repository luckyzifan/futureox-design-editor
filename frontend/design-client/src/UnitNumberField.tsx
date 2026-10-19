import type { ComponentProps } from 'react'
import { NumberField } from './fields'

/** Convert only the edited value back to native units. Other authored fields
 * retain their original bits; keyboard steps remain visible design pixels. */
export function UnitNumberField({ unitScale = 1, value, onChange, min = -1e6, max = 1e6, ...props }: ComponentProps<typeof NumberField> & { unitScale?: number }) {
  return <NumberField {...props} value={value * unitScale} min={min * unitScale} max={max * unitScale} onChange={v => onChange(v / unitScale)} />
}
