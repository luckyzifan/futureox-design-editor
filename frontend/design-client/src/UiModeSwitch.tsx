import { useInterfacePreferences } from './interface-preference'
import { applyInterfaceLayout, FIGMA_LAYOUT_COMBO, SKETCH_LAYOUT_COMBO } from './interface-layout'
import { formatShortcutCombo, shortcutPlatform } from './shortcut-profiles'

/** Persistent Figma / Sketch layout. The shell reads data-ui-mode from the same preference.
 * Each layout also selects the matching editor shortcut profile. */
export function UiModeSwitch() {
  const { uiMode, locale } = useInterfacePreferences()
  const label = locale === 'en' ? 'Interface layout' : '界面布局'
  const platform = shortcutPlatform()
  const figmaKeys = formatShortcutCombo(FIGMA_LAYOUT_COMBO, platform)
  const sketchKeys = formatShortcutCombo(SKETCH_LAYOUT_COMBO, platform)
  return <div className="ui-mode-switch" role="group" aria-label={label}>
    <button type="button" aria-pressed={uiMode === 'figma'} aria-keyshortcuts={FIGMA_LAYOUT_COMBO} title={figmaKeys} onClick={() => applyInterfaceLayout('figma')}>Figma</button>
    <button type="button" aria-pressed={uiMode === 'sketch'} aria-keyshortcuts={SKETCH_LAYOUT_COMBO} title={sketchKeys} onClick={() => applyInterfaceLayout('sketch')}>Sketch</button>
  </div>
}
