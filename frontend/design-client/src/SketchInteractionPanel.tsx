import type { Editor } from './engine'
import type { DesignDocument } from './model'
import type { Interaction, PrototypeAction } from './prototype'
import { isSketchHotspot } from './sketch-hotspot'
import { usePropertyText } from './property-interface-messages'

const previous = '__previous_frame__'
const navigationIndex = (event: Interaction | undefined) =>
  event?.actions.findIndex(action => action.kind === 'navigate' || action.kind === 'back') ?? -1

export function SketchInteractionPanel({ editor, doc, selection, armed }: {
  editor: Editor
  doc: DesignDocument
  selection: readonly string[]
  armed: boolean
}) {
  const { locale } = usePropertyText()
  const english = locale === 'en'
  const layer = selection.length === 1 ? doc.nodes[selection[0]] : undefined
  const hotspot = layer && isSketchHotspot(doc, layer) ? layer : undefined
  if (!armed && !hotspot) return null
  const title = english ? 'Hotspot interaction' : '热点交互'
  const target = english ? 'Link to' : '链接到'
  const events = hotspot ? doc.prototype?.interactions[hotspot.id] : undefined
  const click = events?.find(event => event.trigger === 'click' && !event.condition)
  const action = click?.actions[navigationIndex(click)]
  const frames = Object.values(doc.nodes).filter(node => node.kind === 'frame')
  return <section className="sketch-interaction-panel" aria-label={title}>
    <h3>{title}</h3>
    {hotspot ? <label>{target}<select aria-label={target}
      value={action?.kind === 'back' ? previous : action?.target ?? ''}
      onChange={event => {
        const selected = event.currentTarget.value
        editor.change('修改热点链接', draft => {
          if (!isSketchHotspot(draft, draft.nodes[hotspot.id])) return
          if (selected && selected !== previous && draft.nodes[selected]?.kind !== 'frame') return
          const existing = draft.prototype?.interactions[hotspot.id]?.find(event => event.trigger === 'click' && !event.condition)
          if (!existing && !selected) return
          const interaction: Interaction = existing ?? { trigger: 'click' as const, actions: [] }
          if (!existing) ((draft.prototype ??= { interactions: {} }).interactions[hotspot.id] ??= []).push(interaction)
          const index = navigationIndex(interaction)
          if (!selected) {
            if (index >= 0) interaction.actions.splice(index, 1)
          } else {
            const old = interaction.actions[index]
            const kind = selected === previous ? 'back' : 'navigate'
            const next: PrototypeAction = old?.kind === kind ? { ...old } : { kind, transitionStyle: 'none' }
            if (kind === 'navigate') next.target = selected
            if (index >= 0) interaction.actions[index] = next
            else interaction.actions.push(next)
          }
        })
      }}>
      <option value="">{english ? 'None' : '无'}</option>
      <option value={previous}>{english ? 'Previous frame' : '上一画框'}</option>
      {action?.target && doc.nodes[action.target]?.kind !== 'frame' &&
        <option value={action.target}>{doc.nodes[action.target]?.name ?? action.target}</option>}
      {frames.map(frame => <option key={frame.id} value={frame.id}>{frame.name}</option>)}
    </select></label> : <p>{english ? 'Drag on the canvas to draw a hotspot.' : '在画布上拖动以绘制热点。'}</p>}
  </section>
}
