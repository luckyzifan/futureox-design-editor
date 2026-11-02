import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginUiHost, isPluginUiRequest, isRendererRequestAllowed, PLUGIN_UI_CSP } from '../src/plugin-ui.mjs'

test('renderer requests allow the app, its blobs, data, and one plugin document', () => {
  assert.equal(isRendererRequestAllowed('design-app://app/index.html'), true)
  assert.equal(isRendererRequestAllowed('blob:design-app://app/1234'), true)
  assert.equal(isRendererRequestAllowed('data:image/png;base64,aaaa'), true)
  assert.equal(isRendererRequestAllowed('https://example.com/plugin.js'), false)
  assert.equal(isRendererRequestAllowed('design-app://plugin/not-a-uuid'), false)
  assert.equal(isPluginUiRequest('design-app://plugin.evil/00000000-0000-4000-8000-000000000001'), false)
})

test('plugin UI is one sandboxed document with its own script policy', async () => {
  const host = createPluginUiHost()
  const published = host.publish({ html: '<button id="create">Create</button><script>parent.postMessage({pluginMessage:1}, "*")</script>' })
  assert.equal(published.status, 'ok')
  assert.equal(isPluginUiRequest(published.url), true)
  const response = host.respond(new Request(published.url))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-security-policy'), PLUGIN_UI_CSP)
  assert.match(PLUGIN_UI_CSP, /connect-src 'none'/)
  assert.match(PLUGIN_UI_CSP, /script-src 'unsafe-inline'/)
  assert.match(await response.text(), /pluginMessage/)
  const replaced = host.publish({ html: '<p>next</p>' })
  assert.equal(host.respond(new Request(published.url)).status, 404)
  assert.equal((await host.respond(new Request(replaced.url)).text()).includes('next'), true)
  assert.equal(host.respond(new Request('design-app://app/index.html')), null)
  assert.equal(host.respond(new Request('design-app://plugin/%2e%2e%2fapp')).status, 404)
  assert.equal(host.publish({ html: 'x'.repeat(512 * 1024 + 1) }).status, 'error')
  assert.equal(host.publish({ html: '<p></p>', path: '/tmp/secret' }).status, 'error')
  host.revoke({ id: replaced.id })
  assert.equal(host.respond(new Request(replaced.url)).status, 404)
})
