import { interfacePreference, useInterfacePreferences } from './interface-preference'

/** Persistent Figma / Sketch layout. The shell reads data-ui-mode from the same preference. */
export function UiModeSwitch() {
  const { uiMode, locale } = useInterfacePreferences()
  const label = locale === 'en' ? 'Interface layout' : '界面布局'
  return <div className="ui-mode-switch" role="group" aria-label={label}>
    <button type="button" aria-pressed={uiMode === 'figma'} onClick={() => interfacePreference.set({ uiMode: 'figma' })}>Figma</button>
    <button type="button" aria-pressed={uiMode === 'sketch'} onClick={() => interfacePreference.set({ uiMode: 'sketch' })}>Sketch</button>
  </div>
}
