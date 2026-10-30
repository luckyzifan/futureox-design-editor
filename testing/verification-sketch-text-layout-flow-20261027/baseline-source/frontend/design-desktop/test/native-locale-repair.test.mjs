// Pure menu/catalog + sandbox preload tests, not actual Electron GUI acceptance.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

test('native menu localization preserves commands, accelerators, roles and unknown/authored labels', async () => {
  const { localizeNativeMenu } = await import('../src/native-locale.mjs')
  const click = () => {}, authored = '用户文档 File', template = [{ label: 'File', submenu: [
    { label: 'Save', accelerator: 'CmdOrCtrl+S', click, enabled: false },
    { role: 'close' }, { type: 'separator' }, { label: authored },
  ] }, { label: 'Settings… / 设置' }]
  const zh = localizeNativeMenu(template, 'zh-CN'), en = localizeNativeMenu(template, 'en')
  assert.equal(zh[0].label, '文件'); assert.equal(en[0].label, 'File')
  assert.equal(zh[0].submenu[0].label, '保存'); assert.equal(zh[0].submenu[0].click, click)
  assert.equal(zh[0].submenu[0].accelerator, 'CmdOrCtrl+S'); assert.equal(zh[0].submenu[0].enabled, false)
  assert.equal(zh[0].submenu[1].role, 'close'); assert.equal(zh[0].submenu[1].label, '关闭窗口')
  assert.deepEqual(zh[0].submenu[2], { type: 'separator' }); assert.equal(zh[0].submenu[3].label, authored)
  assert.equal(en[1].label, 'Settings…'); assert.equal(template[0].submenu[0].label, 'Save')
  assert.throws(() => localizeNativeMenu(template, 'de'), /Unsupported interface locale/)
})

test('native catalogs have exact parity and preserve authored interpolation verbatim', async () => {
  const { desktopText } = await import('../src/native-locale.mjs')
  assert.deepEqual(Object.keys(desktopText.en), Object.keys(desktopText['zh-CN']))
  const authored = '报告 English 用户.fd'
  for (const catalog of Object.values(desktopText)) {
    assert.equal(Object.isFrozen(catalog), true)
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, typeof desktopText.en[key]); assert.ok(typeof value === 'function' || value.length > 0)
    }
    assert.ok(catalog.replaceMessage(authored).includes(authored))
    assert.ok(catalog.replaceDetail(authored).includes(authored))
    assert.ok(catalog.recoverMessage(authored).includes(authored))
    assert.ok(catalog.closeUnsavedDetail.length > 0)
  }
})

for (const reply of [{ status: 'ok' }, { status: 'error', code: 'INVALID_REQUEST', message: 'Invalid locale' }, { status: 'cancelled' }]) {
  test(`locale preload uses narrow IPC and preserves ${reply.status} result`, async () => {
    const source = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8')
    let api
    const calls = [], ipcRenderer = Object.assign(new EventEmitter(), { invoke: async (...args) => { calls.push(args); return reply } })
    vm.runInNewContext(source, { process: { argv: [] }, require: name => {
      assert.equal(name, 'electron')
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { api = value } } }
    } })
    assert.equal(await api.setInterfaceLocale('en'), reply)
    assert.deepEqual(calls, [['design-desktop:set-interface-locale', 'en']])
    assert.equal(api.ipcRenderer, undefined)
  })
}
