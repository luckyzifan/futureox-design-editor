import { useSyncExternalStore } from 'react'

export type InterfaceLocale = 'zh-CN' | 'en'
export type InterfacePreferences = Readonly<{ leftWidth: number; rightWidth: number; leftOpen: boolean; rightOpen: boolean; reducedMotion: boolean; rememberViewport: boolean; locale: InterfaceLocale }>
export const INTERFACE_PREFERENCE_KEY = 'forma.interface-preferences.v1'
export const DEFAULT_INTERFACE_PREFERENCES: InterfacePreferences = Object.freeze({ leftWidth: 248, rightWidth: 280, leftOpen: true, rightOpen: true, reducedMotion: false, rememberViewport: false, locale: 'zh-CN' })
export function panelWidth(value: number, side: 'left' | 'right') { return Math.round(Math.min(480, Math.max(side === 'left' ? 208 : 260, value))) }
export function createInterfacePreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let snapshot = DEFAULT_INTERFACE_PREFERENCES, initialized = false, persisted = true
  const listeners = new Set<() => void>()
  const sanitize = (input: unknown): InterfacePreferences => {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    return Object.freeze({ ...DEFAULT_INTERFACE_PREFERENCES,
      ...Object.fromEntries(['leftOpen', 'rightOpen', 'reducedMotion', 'rememberViewport'].flatMap(key => typeof value[key] === 'boolean' ? [[key, value[key]]] : [])),
      leftWidth: typeof value.leftWidth === 'number' && Number.isFinite(value.leftWidth) ? panelWidth(value.leftWidth, 'left') : 248,
      rightWidth: typeof value.rightWidth === 'number' && Number.isFinite(value.rightWidth) ? panelWidth(value.rightWidth, 'right') : 280,
      locale: value.locale === 'en' ? 'en' : 'zh-CN',
    })
  }
  const read = () => { initialized = true; try { const target = storage(); snapshot = sanitize(JSON.parse(target?.getItem(INTERFACE_PREFERENCE_KEY) || '{}')); persisted = !!target } catch { persisted = false } }
  const getSnapshot = () => { if (!initialized) read(); return snapshot }
  const external = (event: StorageEvent) => { if (event.key === INTERFACE_PREFERENCE_KEY || event.key === null) { read(); listeners.forEach(listener => listener()) } }
  return {
    getSnapshot,
    getPersistenceSnapshot: () => { getSnapshot(); return persisted },
    set(patch: Partial<InterfacePreferences>) {
      snapshot = sanitize({ ...getSnapshot(), ...patch })
      try { const target = storage(); target?.setItem(INTERFACE_PREFERENCE_KEY, JSON.stringify(snapshot)); persisted = !!target } catch { persisted = false }
      listeners.forEach(listener => listener()); return persisted
    },
    reset() { return this.set(DEFAULT_INTERFACE_PREFERENCES) },
    subscribe(listener: () => void) { getSnapshot(); listeners.add(listener); if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', external)
      return () => { listeners.delete(listener); if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', external) } },
  }
}
export const interfacePreference = createInterfacePreference(() => typeof localStorage === 'undefined' ? undefined : localStorage)
export function useInterfacePreferences() { return useSyncExternalStore(interfacePreference.subscribe, interfacePreference.getSnapshot, () => DEFAULT_INTERFACE_PREFERENCES) }
export const interfaceText = {
  'zh-CN': { interface: '界面', language: '面板控件语言', languageHelp: '仅影响新增的界面与面板控件；其他编辑功能暂保留原有语言。', rememberViewport: '重新打开时恢复上次视图', rememberViewportHelp: '默认适应页面；开启后记住每个文档的页面、缩放和位置。', motion: '减少动态效果', motionHelp: '关闭界面过渡动画；同时尊重系统的减少动态效果偏好。', reset: '重置面板布局', left: '图层面板', right: '属性面板', resize: '调整面板宽度', collapse: '收起', expand: '展开', temporary: '存储不可用，界面偏好仅在本次会话生效。', design: '设计', prototype: '原型' },
  en: { interface: 'Interface', language: 'Panel controls language', languageHelp: 'Applies to the new interface and panel controls only. Other editor features retain their existing language.', rememberViewport: 'Restore last view when reopening', rememberViewportHelp: 'Fit the page by default. Enable to remember each document’s page, zoom and position.', motion: 'Reduce motion', motionHelp: 'Disable interface transitions. The system’s reduced-motion preference is also respected.', reset: 'Reset panel layout', left: 'Layers panel', right: 'Properties panel', resize: 'Resize panel', collapse: 'Collapse', expand: 'Expand', temporary: 'Storage is unavailable. Interface preferences apply to this session only.', design: 'Design', prototype: 'Prototype' },
} as const
