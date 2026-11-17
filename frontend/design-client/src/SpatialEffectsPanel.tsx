import { useId, useLayoutEffect, useRef } from 'react'
import { Box, Eye, EyeOff, Minus, RotateCcw, Scan, Trash2, X } from 'lucide-react'
import type { Editor } from './engine'
import { NumberField } from './fields'
import { useInterfacePreferences } from './interface-preference'
import type { DesignNode, SpatialEffects } from './model'
import { commitPendingEdits } from './pending-edits'

export type SpatialKind = 'pose' | 'perspective'

export function addSpatialEffect(editor: Editor, layerId: string, kind: SpatialKind) {
  const before = editor.authoredDocument
  editor.updateProperties([layerId], (layer, doc) => {
    if (layer.spatial?.[kind]) return
    if (doc.schemaVersion < 24) doc.schemaVersion = 24
    const spatial = layer.spatial ??= {}
    if (kind === 'pose') spatial.pose = {
      rotateX: 0, rotateY: 0, rotateZ: 0, depth: 0, origin: [0.5, 0.5], visible: true, backfaceVisible: true,
    }
    else spatial.perspective = { distance: Math.max(1, Math.min(1e7, Math.round(Math.max(layer.width, layer.height) * 1.8))), visible: true }
  }, kind === 'pose' ? '添加 3D 变换' : '添加透视')
  return before !== editor.authoredDocument && !!editor.authoredDocument.nodes[layerId]?.spatial?.[kind]
}

export function SpatialEffectRow({ editor, layer, kind, open, onOpen }: {
  editor: Editor; layer: DesignNode; kind: SpatialKind; open: boolean; onOpen: (open: boolean) => void
}) {
  const { locale } = useInterfacePreferences()
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const name = kind === 'pose' ? label('3D 变换', '3D transform') : label('透视', 'Perspective')
  const settings = `${name} · ${label('设置', 'Settings')}`
  const effect = layer.spatial?.[kind]
  const pose = kind === 'pose' ? layer.spatial?.pose : undefined
  const perspective = kind === 'perspective' ? layer.spatial?.perspective : undefined
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  const close = (restore = false) => {
    if (!commitPendingEdits(editor)) return
    openRef.current(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (!open || !popup.current || !trigger.current) return
    const panel = popup.current, button = trigger.current
    panel.showPopover?.()
    const position = () => {
      const box = button.getBoundingClientRect()
      panel.style.left = `${Math.max(8, box.left - panel.offsetWidth - 8)}px`
      panel.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - panel.offsetHeight - 8))}px`
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !button.contains(event.target)) close()
    }
    position()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      if (panel.hidePopover && panel.matches(':popover-open')) panel.hidePopover()
    }
  }, [open, editor])
  if (!effect) return null
  const change = (history: string, apply: (spatial: SpatialEffects) => void) => {
    editor.updateProperties([layer.id], target => {
      if (!target.spatial?.[kind]) return
      apply(target.spatial)
      if (!target.spatial.pose && !target.spatial.perspective && !target.spatial.preserve3d) delete target.spatial
    }, history)
  }
  return <div className="blur-effect spatial-effect">
    <div className="blur-effect-row">
      <button type="button" ref={trigger} className="blur-settings-trigger" aria-label={settings}
        aria-expanded={open} aria-haspopup="dialog" aria-controls={id} onClick={() => open ? close(true) : onOpen(true)}>
        {kind === 'pose' ? <Box size={14} /> : <Scan size={14} />}<span>{name}</span>
      </button>
      <div className="mini-actions">
        <button type="button" aria-pressed={effect.visible} aria-label={label(`启用 ${name}`, `Enable ${name}`)}
          title={label(`显示或隐藏 ${name}`, `Show or hide ${name}`)} onClick={() => change('切换 3D 效果可见性', spatial => {
            const target = spatial[kind]
            if (target) target.visible = !target.visible
          })}>{effect.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
        <button type="button" aria-label={label(`移除 ${name}`, `Remove ${name}`)}
          onClick={() => change('移除 3D 效果', spatial => { delete spatial[kind] })}><Trash2 size={13} /></button>
      </div>
    </div>
    <div ref={popup} id={id} popover="manual" hidden={!open} role="dialog" aria-label={settings}
      className="glass-settings-popover blur-settings-popover"
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true) }
      }}>
      <div className="glass-settings-header">
        <strong>{name}</strong>
        <button type="button" aria-label={label('关闭', 'Close')} onClick={() => close(true)}><X size={15} /></button>
      </div>
      {pose && <div className="blur-settings-body effect-fields spatial-effect-fields">
        <label>{label('原点', 'Origin point')}<select aria-label={label('原点', 'Origin point')} value={pose.origin.join(',')}
          onChange={event => {
            const [x, y] = event.target.value.split(',').map(Number)
            change('修改 3D 原点', spatial => { if (spatial.pose) spatial.pose.origin = [x, y] })
          }}>
          {[['左上', 'Top left', 0, 0], ['上中', 'Top center', 0.5, 0], ['右上', 'Top right', 1, 0],
            ['左中', 'Center left', 0, 0.5], ['中心', 'Center', 0.5, 0.5], ['右中', 'Center right', 1, 0.5],
            ['左下', 'Bottom left', 0, 1], ['下中', 'Bottom center', 0.5, 1], ['右下', 'Bottom right', 1, 1]].map(([zh, en, x, y]) =>
            <option key={`${x},${y}`} value={`${x},${y}`}>{label(String(zh), String(en))}</option>)}
        </select></label>
        {(['X', 'Y', 'Z'] as const).map(axis => <NumberField key={axis} label={label(`${axis} 旋转`, `${axis} rotation`)}
          value={pose[`rotate${axis}`]} min={-36000} max={36000} unit="angle"
          onChange={value => change('修改 3D 旋转', spatial => { if (spatial.pose) spatial.pose[`rotate${axis}`] = value })} />)}
        <NumberField label={label('深度', 'Depth')} value={pose.depth} min={-1e6} max={1e6} unit="number"
          onChange={value => change('修改 3D 深度', spatial => { if (spatial.pose) spatial.pose.depth = value })} />
        <label><input type="checkbox" checked={pose.backfaceVisible} onChange={event => {
          const visible = event.target.checked
          change('切换 3D 背面', spatial => { if (spatial.pose) spatial.pose.backfaceVisible = visible })
        }} />{label('显示背面', 'Show backface')}</label>
        <button type="button" className="wide-button" onClick={() => change('重置 3D 旋转', spatial => {
          if (spatial.pose) Object.assign(spatial.pose, { rotateX: 0, rotateY: 0, rotateZ: 0 })
        })}><RotateCcw size={13} />{label('重置旋转', 'Reset rotation')}</button>
      </div>}
      {perspective && <div className="blur-settings-body effect-fields spatial-effect-fields">
        <NumberField label={label('透视距离', 'Distance')} value={perspective.distance} min={1} max={1e7} unit="number"
          onChange={value => change('修改透视距离', spatial => { if (spatial.perspective) spatial.perspective.distance = value })} />
      </div>}
    </div>
  </div>
}

export function PreserveDepthControl({ editor, layer }: { editor: Editor; layer: DesignNode }) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const enabled = !!layer.spatial?.preserve3d
  const setMode = (preserve: boolean) => {
    if (preserve === enabled) return
    editor.updateProperties([layer.id], (node, doc) => {
      if (preserve) {
        doc.schemaVersion = 25
        ;(node.spatial ??= {}).preserve3d = true
      } else if (node.spatial) {
        delete node.spatial.preserve3d
        if (!node.spatial.pose && !node.spatial.perspective) delete node.spatial
      }
    }, preserve ? '保留嵌套图层 3D' : '转为平面')
  }
  const names = en ? ['Turn into flat plane', 'Keep nested layers 3D'] : ['转为平面', '保留嵌套图层 3D']
  return <div className="spatial-depth-control">
    <span>{en ? 'Preserve 3D' : '保留 3D'}</span>
    <div className="blur-settings-modes" role="radiogroup" aria-label={en ? 'Preserve 3D' : '保留 3D'}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const preserve = event.key === 'Home' ? false : event.key === 'End' ? true : !enabled
        setMode(preserve)
        event.currentTarget.querySelectorAll('button')[preserve ? 1 : 0]?.focus()
      }}>
      {names.map((name, i) => {
        const selected = enabled === Boolean(i)
        return <button key={i} type="button" role="radio" aria-checked={selected}
          aria-pressed={selected} aria-label={name} title={name} tabIndex={selected ? 0 : -1}
          onClick={() => setMode(Boolean(i))}>{i ? <Box size={15} aria-hidden /> : <Minus size={15} aria-hidden />}</button>
      })}
    </div>
  </div>
}
