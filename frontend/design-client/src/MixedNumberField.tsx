import { usePropertyText } from './property-interface-messages'
import { InputFamily } from './input-diagnostics'
import { numericExpression, propertyUnit, type NumericUnit } from './numeric-expression'
import { DraftInput } from './DraftInput'
import { NumberField } from './fields'

/** Mixed values are intentionally blank. A new value is an explicit batch edit. */
export function MixedNumberField({ label, value, onChange, min = -1e6, max = 1e6, bases, onExpression, unit = propertyUnit(label), unitDescription, diagnosticFamily, historyLabel = label }: {
  unitDescription?: string
  unit?: NumericUnit
  historyLabel?: string
  diagnosticFamily?: number
  label: string
  value: number | undefined
  onChange: (value: number) => void
  min?: number
  max?: number
  bases?: number[]
  onExpression?: (expression: string) => void
}) {
  const { tr } = usePropertyText()
  if (value !== undefined) return <NumberField unitDescription={unitDescription} historyLabel={historyLabel} unit={unit} diagnosticFamily={diagnosticFamily} label={label} value={value} min={min} max={max} onChange={onChange} />
  const parsed = (text: string, base = 0) => { try { return numericExpression(text, base, unit) } catch { return NaN } }
  const valid = (text: string) => {
    if (!onExpression && (/^[+*/-]=/.test(text) || text.includes('%')) && unit !== 'percent') return false
    return (bases || [0]).every(base => { const value = parsed(text, base); return Number.isFinite(value) && value >= min && value <= max })
  }
  return <label className="number-field mixed-field"><span title={label}>{label}{unitDescription && <small title={unitDescription}>＊</small>}</span><DraftInput diagnosticFamily={InputFamily.mixed}
    aria-label={label} aria-description={[tr("所选图层的数值不同；输入数值可同时修改"), unitDescription].filter(Boolean).join("；")} title={unitDescription} value="" placeholder={tr("混合")}
    inputMode="decimal" normalize={(text) => text.trim()} validate={(text) => text === '' || valid(text)}
    onCommit={(text) => { if (text.trim()) { if (onExpression) onExpression(text); else onChange(parsed(text)) } }}
  /></label>
}
