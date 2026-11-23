import { useInterfacePreferences } from './interface-preference'
import { applyInterfaceLayout, FIGMA_LAYOUT_COMBO, SKETCH_LAYOUT_COMBO } from './interface-layout'
import { formatShortcutCombo, shortcutPlatform } from './shortcut-profiles'
import { setFigmaDevMode, useFigmaDevMode } from './figma-dev-mode'

/** Persistent Figma / Sketch layout. The shell reads data-ui-mode from the same preference.
 * Each layout also selects the matching editor shortcut profile. */
export function UiModeSwitch({ disabled = false }: { disabled?: boolean }) {
  const { uiMode, locale } = useInterfacePreferences()
  const devMode = useFigmaDevMode()
  const label = locale === 'en' ? 'Interface layout' : '界面布局'
  const platform = shortcutPlatform()
  const figmaKeys = formatShortcutCombo(FIGMA_LAYOUT_COMBO, platform)
  const sketchKeys = formatShortcutCombo(SKETCH_LAYOUT_COMBO, platform)
  // The default Sketch scheme uses this chord to focus layer find.
  const figmaShortcut = uiMode === 'sketch' ? undefined : FIGMA_LAYOUT_COMBO
  return <div className="ui-mode-switch" role="group" aria-label={label}>
    <button type="button" disabled={disabled} aria-pressed={uiMode === 'figma'} aria-keyshortcuts={figmaShortcut} title={figmaShortcut ? figmaKeys : undefined} onClick={() => applyInterfaceLayout('figma')}>Figma</button>
    <button type="button" disabled={disabled} aria-pressed={uiMode === 'sketch'} aria-keyshortcuts={SKETCH_LAYOUT_COMBO} title={sketchKeys} onClick={() => applyInterfaceLayout('sketch')}>Sketch</button>
    {uiMode === 'figma' && <button type="button" data-testid="dev-mode-toggle" aria-pressed={devMode} aria-keyshortcuts="Shift+D" title={locale === 'en' ? 'Dev Mode (Shift D)' : '开发模式（Shift D）'} onClick={() => setFigmaDevMode(!devMode)}>{locale === 'en' ? 'Dev' : '开发'}</button>}
  </div>
}
