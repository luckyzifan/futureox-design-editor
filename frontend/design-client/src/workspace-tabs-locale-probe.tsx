/**
 * Issue #286 gate. Mounts the real WorkspaceTabs and LocalHome against the
 * real shell styles. Geometry, hit-testing, and Tab order are read in the
 * browser; this file does not invent widths.
 */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { shellDensity } from './AdaptivePanels'
import type { DesktopSession } from './desktop-session'
import { interfacePreference, useInterfacePreferences } from './interface-preference'
import { LocalHome } from './LocalHome'
import type { HomeSource } from './local-home-source'
import type { DesignDocument } from './model'
import { WorkspaceTabs } from './WorkspaceTabs'
import './styles.css'

type Locale = 'en' | 'zh-CN'
type Mode = 'figma' | 'sketch'
type Tab = { id: string; name: string; persisted: boolean }

const INITIAL_TABS: Tab[] = [
  { id: 'qa-a', name: 'Layout and operation QA', persisted: true },
  { id: 'qa-b', name: 'QA Document B', persisted: true },
]
let tabs: Tab[] = INITIAL_TABS.map(tab => ({ ...tab }))
let actions: string[] = []
let listed = false
let savedLabel: string | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

const source: HomeSource = {
  kind: 'web-local',
  async list() { listed = true; return [] },
  async open() { return false },
}

function buttonSnapshot(button: HTMLButtonElement, nav: DOMRect) {
  const box = button.getBoundingClientRect()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = document.elementFromPoint(x, y)
  return {
    label: button.getAttribute('aria-label') || button.textContent || '',
    role: button.getAttribute('role'),
    className: button.className,
    disabled: button.disabled,
    centerHit: !!hit && button.contains(hit),
    hit: describeHit(hit),
    x: round(box.x), y: round(box.y), w: round(box.width), h: round(box.height),
    centerInsideNav: x >= nav.left - 0.5 && x <= nav.right + 0.5 && y >= nav.top - 0.5 && y <= nav.bottom + 0.5,
  }
}

function describeHit(hit: Element | null) {
  if (!hit) return null
  const label = hit.getAttribute('aria-label')
  if (label) return label
  return typeof hit.className === 'string' && hit.className ? hit.className : hit.tagName
}

function round(value: number) { return Math.round(value * 100) / 100 }

function focusSnapshot() {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  return {
    label: active?.getAttribute('aria-label') || active?.textContent?.trim().slice(0, 80) || null,
    tag: active?.tagName ?? null,
    inWorkspaceTabs: !!active?.closest('[data-workspace-tabs]'),
    inHome: !!active?.closest('.local-home'),
  }
}

function read() {
  const shell = document.querySelector<HTMLElement>('.editor-shell')
  const nav = document.querySelector<HTMLElement>('[data-workspace-tabs]')
  const navBox = nav?.getBoundingClientRect()
  const shellBox = shell?.getBoundingClientRect()
  const style = nav ? getComputedStyle(nav) : null
  const shellStyle = shell ? getComputedStyle(shell) : null
  const home = document.querySelector<HTMLElement>('.local-home')
  const direct = (selector: string) => shell?.querySelector<HTMLElement>(`:scope > ${selector}`) ?? null
  const placed = (selector: string) => {
    const element = direct(selector)
    return element ? { inert: element.hasAttribute('inert'), visibility: getComputedStyle(element).visibility } : null
  }
  return {
    locale: interfacePreference.getSnapshot().locale,
    uiMode: interfacePreference.getSnapshot().uiMode,
    modeAttribute: shell?.getAttribute('data-ui-mode') ?? null,
    density: shell?.getAttribute('data-density') ?? null,
    home: !!home,
    homeBusy: home?.getAttribute('aria-busy') ?? null,
    homeSettled: !home || (listed && home.getAttribute('aria-busy') !== 'true'),
    label: nav?.getAttribute('aria-label') ?? null,
    marker: nav?.hasAttribute('data-workspace-tabs') ?? false,
    navWidth: navBox ? round(navBox.width) : null,
    navHeight: navBox ? round(navBox.height) : null,
    shellWidth: shellBox ? round(shellBox.width) : null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    gridColumn: style?.gridColumn ?? null,
    gridTemplateColumns: shellStyle?.gridTemplateColumns ?? null,
    visibility: style?.visibility ?? null,
    inert: nav?.hasAttribute('inert') ?? null,
    placed: {
      header: placed('header'),
      main: placed('main.editor-workspace'),
      nav: placed('nav[data-workspace-tabs]'),
      footer: placed('footer'),
    },
    searchFocused: document.activeElement === document.querySelector('[aria-label="搜索最近设计"]'),
    focus: focusSnapshot(),
    actions: [...actions],
    tabNames: [...(nav?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? [])].map(button => ({
      name: button.textContent,
      selected: button.getAttribute('aria-selected'),
      disabled: button.disabled,
    })),
    buttons: nav && navBox ? [...nav.querySelectorAll<HTMLButtonElement>('button')].map(button => buttonSnapshot(button, navBox)) : [],
  }
}

function Probe() {
  const { locale, uiMode } = useInterfacePreferences()
  const [home, setHome] = useState(() => new URLSearchParams(location.search).get('home') === '1')
  const [active, setActive] = useState(INITIAL_TABS[0].id)
  const [width, setWidth] = useState(() => window.innerWidth)
  const homeSetter = useRef(setHome)
  const activeSetter = useRef(setActive)
  const widthSetter = useRef(setWidth)
  homeSetter.current = setHome
  activeSetter.current = setActive
  widthSetter.current = setWidth
  const session = useRef<DesktopSession | null>(null)
  if (!session.current) {
    session.current = {
      subscribeTabs(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      tabsSnapshot: () => tabs,
      async requestWorkspaceTab(id: string) {
        actions.push(`switch:${id}`)
        flushSync(() => activeSetter.current(id))
        return true
      },
      async closeWorkspaceTab(id: string) {
        actions.push(`close:${id}`)
        tabs = tabs.filter(tab => tab.id !== id)
        emit()
        flushSync(() => activeSetter.current(current => current === id ? (tabs[0]?.id ?? current) : current))
        return true
      },
      async replace(document: DesignDocument) {
        actions.push(`new:${document.name}:${document.id}`)
        const next = { id: document.id, name: document.name, persisted: true }
        tabs = [...tabs, next]
        emit()
        flushSync(() => activeSetter.current(document.id))
        return true
      },
    } as unknown as DesktopSession
  }
  const tabsSession = session.current
  if (!tabsSession) throw new Error('workspace tab session was not created')
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useLayoutEffect(() => {
    window.__tabsProbe = {
      read,
      focus: focusSnapshot,
      setLocale(next: Locale) {
        flushSync(() => { interfacePreference.set({ locale: next }) })
        return read()
      },
      setMode(next: Mode) {
        flushSync(() => { interfacePreference.set({ uiMode: next }) })
        return read()
      },
      setHome(next: boolean) {
        flushSync(() => homeSetter.current(next))
        return read()
      },
      syncWidth() {
        flushSync(() => widthSetter.current(window.innerWidth))
        return read()
      },
      retitle(name: string | null) {
        const nav = document.querySelector('[data-workspace-tabs]')
        if (!nav) return read()
        if (name === null) {
          if (savedLabel !== null) nav.setAttribute('aria-label', savedLabel)
          savedLabel = null
        } else {
          if (savedLabel === null) savedLabel = nav.getAttribute('aria-label')
          nav.setAttribute('aria-label', name)
        }
        return read()
      },
      resetDocuments() {
        tabs = INITIAL_TABS.map(tab => ({ ...tab }))
        actions = []
        emit()
        flushSync(() => activeSetter.current(INITIAL_TABS[0].id))
        return read()
      },
      resumeButton() {
        const button = [...document.querySelectorAll<HTMLButtonElement>('.local-home button')].find(item => item.textContent?.includes('继续编辑'))
        if (!button) return null
        const box = button.getBoundingClientRect()
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        const hit = document.elementFromPoint(x, y)
        return { x, y, centerHit: !!hit && button.contains(hit), disabled: button.disabled, label: button.textContent }
      },
    }
  }, [])
  return <div
    className={`app-shell editor-shell${home ? ' home-route-active' : ''}`}
    data-ui-mode={uiMode}
    data-density={shellDensity(width)}
    data-host="web"
    data-locale={locale}
  >
    {home && <LocalHome source={source} ready currentName="Layout and operation QA" onResume={() => setHome(false)} onNew={async () => false} onOpenFile={async () => 'pending'} onSettings={() => {}} />}
    <header className="editor-header">
      <button type="button" className="brand" aria-label="file">F</button>
      <div className="document-title">
        <input aria-label="document name" defaultValue="Layout and operation QA" />
      </div>
      <div className="header-right" />
    </header>
    <WorkspaceTabs session={tabsSession} activeId={active} />
    <main className="editor-workspace">
      <div className="workspace-rail" />
      <div className="adaptive-layers-shell"><div className="layers-panel" /></div>
      <div className="canvas-workspace" />
      <div className="properties-workspace" />
    </main>
    <footer><span>status</span></footer>
  </div>
}

declare global {
  interface Window {
    __tabsProbe?: {
      read: typeof read
      focus: typeof focusSnapshot
      setLocale: (locale: Locale) => ReturnType<typeof read>
      setMode: (mode: Mode) => ReturnType<typeof read>
      setHome: (home: boolean) => ReturnType<typeof read>
      syncWidth: () => ReturnType<typeof read>
      retitle: (name: string | null) => ReturnType<typeof read>
      resetDocuments: () => ReturnType<typeof read>
      resumeButton: () => { x: number; y: number; centerHit: boolean; disabled: boolean; label: string | null } | null
    }
    __bootError?: string
    __pageErrors?: string[]
  }
}

window.__pageErrors = []
window.addEventListener('error', event => { window.__pageErrors?.push(String(event.error || event.message)) })
window.addEventListener('unhandledrejection', event => { window.__pageErrors?.push(String(event.reason)) })

const root = document.getElementById('root')
if (!root) window.__bootError = 'missing root'
else createRoot(root).render(<Probe />)
