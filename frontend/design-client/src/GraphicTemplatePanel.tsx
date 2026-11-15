import { SquareDashed } from 'lucide-react'
import { useState } from 'react'
import type { Editor } from './engine'
import { createPresetFrame } from './frame-presets'
import { usePropertyText } from './property-interface-messages'

const iconSizes = [16, 32, 128, 180, 512] as const

export function GraphicTemplatePanel({ editor }: { editor: Editor }) {
  const { tr } = usePropertyText()
  const [error, setError] = useState('')
  return <aside className="inspector graphic-template-panel" aria-label={tr('图形模板')}>
    <div className="panel-tabs"><b>{tr('图形模板')}</b></div>
    <div className="inspector-scroll">
      <section>
        <h3>{tr('图标')}</h3>
        <div className="graphic-template-list">
          {iconSizes.map(size => <button key={size} type="button" aria-label={`${size}×${size}`}
            onClick={() => {
              const result = createPresetFrame(editor, {name:`${size}x${size}`, width:size, height:size}, 'graphic')
              if (!result.ok) setError(result.error || '')
            }}>
            <span className="graphic-template-preview"><SquareDashed size={24}/></span>
            <span>{size}×{size}</span>
          </button>)}
        </div>
        {error && <p role="alert">{tr(error)}</p>}
      </section>
    </div>
  </aside>
}
