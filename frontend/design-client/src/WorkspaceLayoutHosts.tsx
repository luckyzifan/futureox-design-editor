import type { ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import { AnchoredMenu } from './anchored-menu'
import type { PropertiesTab } from './prototype-chrome'

type LeftPanel = { panelRef: Ref<HTMLDivElement>; rail: ReactNode; navigation: ReactNode; resize: ReactNode; children: ReactNode; inactive?: boolean }

function FigmaLayersWorkspace({ panelRef, rail, navigation, resize, children, inactive }: LeftPanel) {
  return <>{rail}<div ref={panelRef} className="adaptive-layers-shell" data-workspace-host="figma-layers" inert={inactive}>
    {navigation}{children}{resize}
  </div></>
}

function SketchLayersWorkspace({ panelRef, navigation, resize, children }: LeftPanel) {
  return <div ref={panelRef} className="adaptive-layers-shell" data-workspace-host="sketch-layers">
    {navigation}{children}{resize}
  </div>
}

type RightPanel = {
  panelRef: Ref<HTMLDivElement>
  label: string
  resize: ReactNode
  children: ReactNode
  agent: ReactNode
}
type InspectorTabs = {
  tab: PropertiesTab
  onTab: (tab: PropertiesTab) => void | boolean
  titles: Record<PropertiesTab, string>
}

function PropertyTabs({ label, tab, onTab, titles }: InspectorTabs & { label: string }) {
  return <div className="properties-tab-buttons" role="tablist" aria-label={label} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const next = event.key === 'Home' ? 'design' : event.key === 'End' ? 'prototype' : tab === 'design' ? 'prototype' : 'design'
    if (onTab(next) !== false) document.getElementById(`${next}-properties-tab`)?.focus()
  }}>
    {(['design', 'prototype'] as const).map(value =>
      <button key={value} type="button" role="tab" id={`${value}-properties-tab`} tabIndex={tab === value ? 0 : -1}
        aria-selected={tab === value} aria-controls={`${value}-properties`} onClick={() => onTab(value)}>{titles[value]}</button>)}
  </div>
}

function PropertyTabContent({ tab, children }: { tab: PropertiesTab; children: ReactNode }) {
  return <div className="properties-content" id={`${tab}-properties`} role="tabpanel" aria-labelledby={`${tab}-properties-tab`}>
    {children}
  </div>
}

export function FigmaPropertiesWorkspace({ panelRef, label, resize, children, agent, tab, onTab, titles, zoom, preview, inactive }: RightPanel & InspectorTabs & {
  zoom: ReactNode
  preview: ReactNode
  inactive?: boolean
}) {
  return <div ref={panelRef} className="properties-workspace" data-workspace-host="figma-inspector" inert={inactive}>
    {resize}
    {preview && <div className="figma-properties-actions">{preview}</div>}
    <div className="properties-tabs">
      <PropertyTabs label={label} tab={tab} onTab={onTab} titles={titles} />
      {zoom}
    </div>
    <PropertyTabContent tab={tab}>{children}</PropertyTabContent>
    {agent}
  </div>
}

export function SketchPropertiesWorkspace({ panelRef, label, resize, children, agent, tab, onTab, titles }: RightPanel & InspectorTabs) {
  return <div ref={panelRef} className="properties-workspace" data-workspace-host="sketch-inspector">
    {resize}
    <div className="properties-tabs"><PropertyTabs label={label} tab={tab} onTab={onTab} titles={titles} /></div>
    <PropertyTabContent tab={tab}>{children}</PropertyTabContent>
    {agent}
  </div>
}

type FileMenuProps = { anchor: HTMLElement | null; close: () => void; children: ReactNode }
function FileMenuPortal({ anchor, close, children, className }: FileMenuProps & { className: string }) {
  return createPortal(<>
    <div className="menu-scrim" onClick={close} />
    <AnchoredMenu anchor={anchor} className={`file-menu ${className}`} prefer="below">{children}</AnchoredMenu>
  </>, document.body)
}

function FigmaFileMenu(props: FileMenuProps) {
  return <FileMenuPortal {...props} className="figma-file-menu" />
}

function SketchFileMenu(props: FileMenuProps) {
  return <FileMenuPortal {...props} className="sketch-file-menu" />
}

export const workspaceLayoutHosts = {
  figma: { Layers: FigmaLayersWorkspace, FileMenu: FigmaFileMenu },
  sketch: { Layers: SketchLayersWorkspace, FileMenu: SketchFileMenu },
}
