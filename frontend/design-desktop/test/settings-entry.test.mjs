import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { nativeShortcutRoute, forwardNativeEditorShortcut } from '../src/keyboard-shortcuts.mjs'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../../design-client/src/App.tsx'), css = read('../../design-client/src/styles.css')
for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: Settings shortcut is forwarded once and respects IME/repeat/modifiers`, () => {
    const mod = platform === 'darwin' ? { meta: true } : { control: true }
    const input = { type:'keyDown', key:',', ...mod }
    assert.equal(nativeShortcutRoute(input,platform).command,'settings')
    for (const extra of [{isComposing:true},{keyCode:229},{isAutoRepeat:true},{shift:true},{alt:true},{meta:true,control:true},{type:'keyUp'}]) assert.equal(nativeShortcutRoute({...input,...extra},platform).command,undefined)
    let count=0, prevented=0
    forwardNativeEditorShortcut({preventDefault(){prevented++}},input,{platform,sendCommand(cmd){assert.equal(cmd,'settings');count++},setIgnoreMenuShortcuts(){}})
    assert.equal(count,1); assert.equal(prevented,1)
  })
}
test('preload passes only supported commands, including Settings, and unsubscribes', () => {
  let bridge;const listeners=new Map()
  vm.runInNewContext(read('../src/preload.cjs'),{process:{argv:[]},require(name){assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld(_name,value){bridge=value}},ipcRenderer:{on(k,f){listeners.set(k,f)},removeListener(k){listeners.delete(k)},invoke(){return Promise.resolve({})}}}}})
  const seen=[],stop=bridge.onCommand(c=>seen.push(c)),listener=listeners.get('design-desktop:command')
  listener({},'settings');listener({},'arbitrary-shell');assert.deepEqual(seen,['settings']);stop();assert.equal(listeners.size,0)
})
test('native menu Settings item invokes supported command with standard accelerator', () => {
  const source=read('../src/main.mjs'); const entry=source.match(/\{ label: 'Settings… \/ 设置', accelerator: 'CmdOrCtrl\+,', click: \(\) => sendCommand\('settings'\) \}/)?.[0]
  assert.ok(entry);let sent;const menu=vm.runInNewContext(`(${entry})`,{sendCommand(c){sent=c}});menu.click();assert.equal(sent,'settings');assert.equal(menu.accelerator,'CmdOrCtrl+,')
})
test('Settings retains text despite shared icon-only header styling and uses distinct gear', () => {
  const rule=css.match(/\.editor-shell \.header-right > \.app-settings-button \{([^}]+)\}/)?.[1]
  assert.ok(rule);assert.match(rule,/font-size:\s*12px/);assert.match(rule,/flex-shrink:\s*0/)
  assert.ok(css.indexOf('.editor-shell .header-right > .app-settings-button')>css.indexOf('.editor-shell .header-right > button'))
  assert.match(app,/<SettingsIcon size=\{16\} \/><span>设置<\/span>/)
  assert.match(app,/正在处理设计文件，完成后可打开设置/)
})
test('all Settings routes share ready, transition, interaction, modal and pending-edit guards', () => {
  const body=app.match(/const openSettings = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[ready, switching, desktopStatus.transitioning, editor\]\)/)?.[1];assert.ok(body)
  const invoke=Function('ready','switching','desktopStatus','editor','modalOwnsKeyboard','document','commitPendingEdits','setMenu','setShowSettings',body)
  for (const block of ['ready','switching','transitioning','interaction','modal','commit',null]) {
    const calls=[];invoke(block!=='ready',block==='switching',{transitioning:block==='transitioning'},{interactionActive:block==='interaction'},()=>block==='modal',{activeElement:null},()=>block!=='commit',v=>calls.push(['menu',v]),v=>calls.push(['settings',v]))
    assert.deepEqual(calls,block?[]:[['menu',false],['settings',true]])
  }
  assert.match(app,/if \(name === 'settings'\) \{ openSettings\(\); return \}/)
  assert.match(app,/e.key === ','[\s\S]*?e.preventDefault\(\); openSettings\(\); return/)
  assert.match(app,/onClick=\{openSettings\}/)
})

// Execute the production shortcut/open callbacks without mounting a renderer.
// These are behavior/source contracts, not a browser visibility or Electron GUI test.
function settingsHarness({ platform = 'mac', target = { tagName: 'INPUT' }, ready = true,
  switching = false, transitioning = false, interactionActive = false, modal = false,
  commit = true } = {}) {
  const calls = []
  const body = app.match(/const openSettings = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[ready, switching, desktopStatus.transitioning, editor\]\)/)?.[1]
  const shortcutBody = app.match(/const shortcut = \(e: KeyboardEvent\) => \{([\s\S]*?)\n      if \(!ready/)?.[1]
  assert.ok(body); assert.ok(shortcutBody)
  const open = Function('ready', 'switching', 'desktopStatus', 'editor', 'modalOwnsKeyboard', 'document', 'commitPendingEdits', 'setMenu', 'setShowSettings', body)
  const openSettings = () => open(ready, switching, { transitioning }, { interactionActive }, focused => {
    assert.equal(focused, target); calls.push('modal-check'); return modal
  }, { activeElement: target }, () => { calls.push('commit'); return commit }, () => calls.push('close-menu'), () => calls.push('open-settings'))
  const shortcut = Function('e', 'shortcutPlatform', 'openSettings', shortcutBody)
  return { calls, openSettings, dispatch(extra = {}) {
    shortcut({ key: ',', metaKey: platform === 'mac', ctrlKey: platform !== 'mac', target,
      preventDefault() { calls.push('prevent'); }, ...extra }, () => platform, openSettings)
  } }
}
for (const platform of ['mac', 'windows', 'linux']) {
  test(`${platform}: focused text control commits before opening Settings via renderer fallback`, () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'contenteditable']) {
      const harness = settingsHarness({ platform, target: { tagName } })
      harness.dispatch()
      assert.deepEqual(harness.calls, ['prevent', 'modal-check', 'commit', 'close-menu', 'open-settings'])
    }
  })
  test(`${platform}: renderer Settings shortcut ignores IME, held keys, modifiers and consumed events`, () => {
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true },
      { altKey: true }, { metaKey: true, ctrlKey: true }, { defaultPrevented: true }, { key: '<' },
      { metaKey: false, ctrlKey: false }]) {
      const harness = settingsHarness({ platform }); harness.dispatch(extra)
      assert.deepEqual(harness.calls, [], JSON.stringify(extra))
    }
  })
}
test('focused modal and uncommittable edits never open Settings or close the current menu', () => {
  const modal = settingsHarness({ modal: true }); modal.dispatch()
  assert.deepEqual(modal.calls, ['prevent', 'modal-check'])
  const pending = settingsHarness({ commit: false }); pending.dispatch()
  assert.deepEqual(pending.calls, ['prevent', 'modal-check', 'commit'])
  // The native-menu command uses the same guarded callback without a DOM key event.
  const nativeModal = settingsHarness({ modal: true }); nativeModal.openSettings()
  assert.deepEqual(nativeModal.calls, ['modal-check'])
})
test('loading, switching and active interaction block shortcut opens before any commit or modal mutation', () => {
  for (const state of [{ ready: false }, { switching: true }, { transitioning: true }, { interactionActive: true }]) {
    const harness = settingsHarness(state); harness.dispatch()
    assert.deepEqual(harness.calls, ['prevent'])
    const native = settingsHarness(state); native.openSettings(); assert.deepEqual(native.calls, [])
  }
  const button = app.match(/<button type="button" className="app-settings-button"[\s\S]*?<\/button>/)?.[0]
  assert.ok(button); assert.match(button, /disabled=\{!ready \|\| switching \|\| desktopStatus.transitioning\}/)
  assert.match(button, /正在处理设计文件，完成后可打开设置/)
})
test('collapsed Inspector CSS keeps the named Settings entry in the canvas grid column', () => {
  const hide = css.match(/\.editor-shell\.chrome-hide-inspector \.header-right \{([^}]+)\}/)?.[1]
  assert.ok(hide); assert.match(hide, /grid-column:\s*3/); assert.match(hide, /justify-self:\s*end/)
  const minimized = css.match(/\.editor-shell\.chrome-minimized\.chrome-hide-inspector \{([^}]+)\}/)?.[1]
  assert.ok(minimized); assert.match(minimized, /grid-template-columns:\s*0 0 minmax\(0, 1fr\) 0/)
  const settingsRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].includes('.app-settings-button'))
  assert.ok(settingsRules.length >= 2)
  for (const [, , declarations] of settingsRules) assert.doesNotMatch(declarations, /display:\s*none|visibility:\s*hidden|font-size:\s*0(?:px)?\b/)
  assert.match(css, /\.editor-shell \.header-right > \.app-settings-button \{[^}]*font-size:\s*12px[^}]*flex-shrink:\s*0[^}]*white-space:\s*nowrap/)
})
test('Electron minimum-width and compact-header contracts preserve Settings label exception', async () => {
  const { fitWindowState } = await import('../src/window-state.mjs')
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }
  const fitted = fitWindowState({ version: 1, bounds: { x: 0, y: 0, width: 700, height: 700 } }, [display], display)
  assert.equal(fitted.minWidth, 1000); assert.equal(fitted.bounds.width, 1000)
  // 1000px falls under the 1100px status-icon compact rule, not the <=900px mobile grid.
  assert.match(css, /@media \(max-width: 1100px\) \{\s*\.editor-shell \.header-right \.save-status \{[^}]*font-size:\s*0/)
  assert.match(css, /\.editor-shell \.header-right > button \{[^}]*font-size:\s*0/)
  assert.match(css, /\.editor-shell \.header-right > \.app-settings-button \{[^}]*font-size:\s*12px/)
  // Small physical displays may be narrower than desktop minimum; mobile header remains right-aligned.
  const small = { workArea: { x: 0, y: 0, width: 800, height: 700 } }
  assert.equal(fitWindowState(undefined, [small], small).minWidth, 800)
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.editor-shell \.editor-header \.header-right \{[^}]*grid-column:\s*3[^}]*justify-self:\s*end[^}]*width:\s*auto/)
})
