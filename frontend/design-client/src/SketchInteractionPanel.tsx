import type { Editor } from './engine'
import type { DesignDocument } from './model'
import type { Interaction, PrototypeAction, PrototypeEasing, PrototypeOverflow, PrototypeTransitionStyle } from './prototype'
import { isSketchHotspot } from './sketch-hotspot'
import { usePropertyText } from './property-interface-messages'
import { DraftInput } from './DraftInput'

const previous = '__previous_frame__'
const navigationIndex = (event: Interaction | undefined) =>
  event?.actions.findIndex(action => action.kind === 'navigate' || action.kind === 'overlay' || action.kind === 'back') ?? -1

function primaryInteraction(events: Interaction[] | undefined) {
  return events?.find(event => !event.condition && event.trigger === 'click') ??
    events?.find(event => !event.condition)
}

function navigationAction(event: Interaction | undefined): PrototypeAction | undefined {
  const index = navigationIndex(event)
  return index >= 0 ? event!.actions[index] : undefined
}

function validTiming(raw: string, limit: number) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= limit
}

const triggers: readonly { value: Interaction['trigger']; zh: string; en: string }[] = [
  { value: 'click', zh: '单击时', en: 'On click' },
  { value: 'hover', zh: '悬停时', en: 'On hover' },
  { value: 'leave', zh: '离开时', en: 'On leave' },
  { value: 'after-delay', zh: '延迟后', en: 'After delay' },
]

const animations: readonly { value: PrototypeTransitionStyle | 'smart'; zh: string; en: string }[] = [
  { value: 'none', zh: '无', en: 'None' },
  { value: 'smart', zh: '智能动画', en: 'Smart Animate' },
  { value: 'dissolve', zh: '溶解', en: 'Dissolve' },
  { value: 'slide-left', zh: '向左滑动', en: 'Slide left' },
  { value: 'slide-right', zh: '向右滑动', en: 'Slide right' },
  { value: 'slide-top', zh: '向上滑动', en: 'Slide up' },
  { value: 'slide-bottom', zh: '向下滑动', en: 'Slide down' },
]

const easings: readonly { value: string; zh: string; en: string }[] = [
  { value: '', zh: '默认（缓出）', en: 'Default (Ease Out)' },
  { value: 'linear', zh: '线性', en: 'Linear' },
  { value: 'ease-in', zh: '缓入', en: 'Ease In' },
  { value: 'ease-out', zh: '缓出', en: 'Ease Out' },
  { value: 'ease-in-out', zh: '缓入缓出', en: 'Ease In Out' },
  { value: 'spring', zh: '弹簧', en: 'Spring' },
]

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
  if (!layer) {
    if (!armed) return null
    return <section className="sketch-interaction-panel" aria-label={english ? 'Interaction' : '交互'}>
      <h3>{english ? 'Interaction' : '交互'}</h3>
      <p>{english ? 'Drag on the canvas to draw a hotspot.' : '在画布上拖动以绘制热点。'}</p>
    </section>
  }
  const title = english ? 'Interaction' : '交互'
  const targetLabel = english ? 'Link to' : '链接到'
  const openAsLabel = english ? 'Open as' : '打开方式'
  const frameTitle = english ? 'Frame settings' : '画框设置'
  const startLabel = english ? 'Start point' : '起点'
  const scrollLabel = english ? 'Scrolling' : '滚动方向'
  const triggerLabel = english ? 'Trigger On' : '触发方式'
  const animationLabel = english ? 'Animation Type' : '动画类型'
  const durationLabel = english ? 'Duration (ms)' : '时长（毫秒）'
  const easingLabel = english ? 'Easing' : '缓动'
  const delayLabel = english ? 'Delay (ms)' : '延迟（毫秒）'
  const maintainScrollLabel = english ? 'Maintain scroll position after click' : '点击后保持滚动位置'
  const event = primaryInteraction(doc.prototype?.interactions[layer.id])
  const action = navigationAction(event)
  const target = action?.kind === 'back' ? previous : action?.target ?? ''
  const trigger = event?.trigger ?? 'click'
  const animation = action && action.kind !== 'overlay' ? action.transitionStyle ?? 'smart' : 'none'
  const durationDisabled = !action || animation === 'none'
  const frames = Object.values(doc.nodes).filter(node => node.kind === 'frame')
  const update = (label: string, change: (draft: DesignDocument, event: Interaction | undefined) => void) =>
    editor.change(label, draft => {
      if (!draft.nodes[layer.id]) return
      change(draft, primaryInteraction(draft.prototype?.interactions[layer.id]))
    })

  return <>
    {layer.kind === 'frame' && <section className="sketch-interaction-panel sketch-prototype-frame" aria-label={frameTitle}>
      <h3>{frameTitle}</h3>
      <label>{startLabel}<input type="checkbox" aria-label={startLabel} disabled={layer.locked}
        checked={doc.prototype?.startNode === layer.id} onChange={event => {
          const enabled = event.currentTarget.checked
          update('设置原型起点', draft => {
            if (draft.nodes[layer.id].locked) return
            if (enabled) (draft.prototype ??= { interactions: {} }).startNode = layer.id
            else if (draft.prototype?.startNode === layer.id) delete draft.prototype.startNode
          })
        }} /></label>
      <label>{scrollLabel}<select aria-label={scrollLabel} value={layer.prototypeOverflow ?? 'none'} disabled={layer.locked}
        onChange={event => {
          const overflow = event.currentTarget.value as PrototypeOverflow
          editor.updateProperties([layer.id], frame => { frame.prototypeOverflow = overflow }, '设置原型溢出滚动')
        }}>
        <option value="none">{english ? 'None' : '无'}</option>
        <option value="vertical">{english ? 'Vertical' : '垂直'}</option>
        <option value="horizontal">{english ? 'Horizontal' : '水平'}</option>
        <option value="both">{english ? 'Both axes' : '双向'}</option>
      </select></label>
    </section>}
    <section className="sketch-interaction-panel" aria-label={title} data-hotspot={hotspot ? 'true' : undefined}>
    <h3>{title}</h3>
    <label>{targetLabel}<select aria-label={targetLabel}
      value={target}
      onChange={change => {
        const selected = change.currentTarget.value
        update('修改交互', (draft, event) => {
          const interactions = (draft.prototype ??= { interactions: {} }).interactions
          const list = interactions[layer.id] ??= []
          let current = event
          if (!selected) {
            if (!current) return
            const index = navigationIndex(current)
            if (index >= 0) current.actions.splice(index, 1)
            if (!current.actions.length) {
              list.splice(list.indexOf(current), 1)
              if (!list.length) delete interactions[layer.id]
            }
            return
          }
          if (selected !== previous && draft.nodes[selected]?.kind !== 'frame') return
          if (!current) {
            current = { trigger: 'click', actions: [] }
            list.push(current)
          }
          const index = navigationIndex(current)
          const old = current.actions[index]
          const kind = selected === previous ? 'back' : old?.kind === 'overlay' ? 'overlay' : 'navigate'
          const next: PrototypeAction = old?.kind === kind ? { ...old } : { kind, transitionStyle: 'none' }
          if (kind !== 'back') next.target = selected
          if (index >= 0) current.actions[index] = next
          else current.actions.push(next)
        })
      }}>
      <option value="">{english ? 'None' : '无'}</option>
      <option value={previous}>{english ? 'Previous frame' : '上一画框'}</option>
      {action?.target && doc.nodes[action.target]?.kind !== 'frame' &&
        <option value={action.target}>{doc.nodes[action.target]?.name ?? action.target}</option>}
      {frames.map(frame => <option key={frame.id} value={frame.id}>{frame.name}</option>)}
    </select></label>
    <label>{openAsLabel}<select aria-label={openAsLabel} value={action?.kind === 'overlay' ? 'overlay' : 'navigate'}
      disabled={!action?.target} onChange={change => {
        const kind = change.currentTarget.value as 'navigate' | 'overlay'
        update('修改交互打开方式', (_draft, event) => {
          const action = navigationAction(event)
          if (!action?.target || action.kind === 'back' || kind === action.kind) return
          action.kind = kind
          if (kind === 'overlay') {
            delete action.transitionStyle
            delete action.transitionShouldSmartAnimate
          } else {
            delete action.overlayPosition
            action.transitionStyle = 'none'
          }
        })
      }}>
      <option value="navigate">{english ? 'Screen' : '屏幕'}</option>
      <option value="overlay">{english ? 'Overlay' : '覆盖层'}</option>
    </select></label>
    <label>{triggerLabel}<select aria-label={triggerLabel} disabled={!action}
      value={trigger}
      onChange={change => {
        const next = change.currentTarget.value as Interaction['trigger']
        update('修改交互触发', (_draft, event) => {
          if (!event) return
          event.trigger = next
          if (next === 'after-delay') event.delayMs ??= 500
          else delete event.delayMs
        })
      }}>
      {triggers.map(item => <option key={item.value} value={item.value}>{english ? item.en : item.zh}</option>)}
    </select></label>
    {trigger === 'after-delay' && <label>{delayLabel}<DraftInput key={layer.id} editor={editor}
      type="number" aria-label={delayLabel} min={0} max={600000} step={100}
      disabled={!action} value={String(event?.delayMs ?? 0)}
      normalize={raw => raw === '' ? '0' : raw} validate={raw => validTiming(raw, 600000)}
      onCommit={raw => {
        update('修改交互触发', (_draft, event) => { if (event) event.delayMs = Math.round(Number(raw)) })
      }} /></label>}
    <label>{animationLabel}<select aria-label={animationLabel} disabled={!action || action.kind === 'overlay'}
      value={animation}
      onChange={change => {
        const next = change.currentTarget.value as PrototypeTransitionStyle | 'smart'
        update('修改交互动画', (_draft, event) => {
          const action = navigationAction(event)
          if (!action || action.kind === 'overlay') return
          if (next === 'smart') {
            delete action.transitionStyle
            delete action.transitionShouldSmartAnimate
            return
          }
          action.transitionStyle = next
          if (next === 'none') {
            delete action.durationMs
            delete action.easingCurve
            delete action.transitionShouldSmartAnimate
          }
        })
      }}>
      {animations.map(item => <option key={item.value} value={item.value}>{english ? item.en : item.zh}</option>)}
    </select></label>
    <label>{durationLabel}<DraftInput key={layer.id} editor={editor}
      type="number" aria-label={durationLabel} min={0} max={10000} step={50}
      disabled={durationDisabled} placeholder="300"
      value={String(action?.durationMs ?? '')}
      validate={raw => validTiming(raw, 10000)}
      onCommit={raw => {
        update('修改交互动画', (_draft, event) => {
          const action = navigationAction(event)
          if (!action) return
          if (raw === '') { delete action.durationMs; return }
          action.durationMs = Math.round(Number(raw))
        })
      }} /></label>
    <label>{easingLabel}<select aria-label={easingLabel} disabled={durationDisabled}
      value={action?.easingCurve ?? ''}
      onChange={change => {
        const next = change.currentTarget.value
        update('修改交互动画', (_draft, event) => {
          const action = navigationAction(event)
          if (!action) return
          if (!next) delete action.easingCurve
          else action.easingCurve = next as PrototypeEasing
        })
      }}>
      {easings.map(item => <option key={item.value || 'default'} value={item.value}>{english ? item.en : item.zh}</option>)}
    </select></label>
    {/* Native Interaction inspector keeps this action flag next to duration/easing. */}
    <label>{maintainScrollLabel}<input type="checkbox" aria-label={maintainScrollLabel}
      disabled={action?.kind !== 'navigate'}
      checked={!!action?.transitionPreserveScroll}
      onChange={change => {
        const enabled = change.currentTarget.checked
        update('修改交互动画', (_draft, event) => {
          const action = navigationAction(event)
          if (!action || action.kind !== 'navigate') return
          if (enabled) action.transitionPreserveScroll = true
          else delete action.transitionPreserveScroll
        })
      }} /></label>
    </section>
  </>
}
