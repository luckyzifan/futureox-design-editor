/** Activate only the owned test app. Keep the production background-throttling
 * setting; a window being visible does not establish foreground ownership. */
export async function foreground(app, page) {
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.show(); app.focus({ steal: true }); window.focus()
  })
  await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), null, { timeout: 10000 })
  return page.evaluate(() => {
    window.__ownedForegroundEvents ??= []
    if (!window.__ownedForegroundObserved) {
      window.__ownedForegroundObserved = true
      const changed = () => window.__ownedForegroundEvents.push({ at: Date.now(), visible: document.visibilityState, focused: document.hasFocus() })
      window.addEventListener('blur', changed); window.addEventListener('focus', changed)
      document.addEventListener('visibilitychange', changed)
    }
    return { at: Date.now(), visible: document.visibilityState, focused: document.hasFocus() }
  })
}
