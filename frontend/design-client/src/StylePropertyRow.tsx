import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'

export function useSketchStyleOptions(sketch: boolean) {
  const [option, setOption] = useState(false)
  useEffect(() => {
    if (!sketch) return
    const sync = (event: KeyboardEvent) => setOption(event.altKey && !event.getModifierState('AltGraph'))
    const reset = () => setOption(false)
    window.addEventListener('keydown', sync, true)
    window.addEventListener('keyup', sync, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', sync, true)
      window.removeEventListener('keyup', sync, true)
      window.removeEventListener('blur', reset)
      reset()
    }
  }, [sketch])
  return sketch && option
}

export function StylePropertyRow({ sketch, label, effect, check, actions, extra, children }: {
  sketch: boolean
  label: string
  effect?: boolean
  check: ReactNode
  actions: ReactNode
  extra?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const details = useId()
  if (!sketch) return <div className="property-card">
    <div className="property-title">
      {effect ? <b>{label}</b> : <span>{label}</span>}
      {extra}{actions}
    </div>
    {children}
  </div>
  return <div className="sketch-style-row">
    <div className="sketch-style-header">
      {check}
      {extra ? <span>{label}</span> : <button type="button" className="sketch-style-disclosure" aria-expanded={open}
        aria-controls={details} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>}
      {extra}{actions}
    </div>
    {!extra && <div className="sketch-style-details" id={details} hidden={!open}>{children}</div>}
  </div>
}
