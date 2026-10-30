import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderCheckConfig, renderCheckHandler } from '../src/render-check.mjs'

test('render checks require a named entry, explicit local inputs and an isolated unpackaged profile', () => {
  assert.equal(renderCheckConfig([]), undefined)
  const args = ['--desktop-isolated-profile','--desktop-render-check=interaction','--desktop-render-check-root=/tmp/bundle','--desktop-render-check-fixture=/tmp/input.fd']
  assert.equal(renderCheckConfig(args).url, 'design-app://app/interaction-surface-check.html')
  assert.throws(() => renderCheckConfig(args, true), /isolated/)
  assert.throws(() => renderCheckConfig(args.slice(1)), /isolated/)
  assert.throws(() => renderCheckConfig([...args.filter(s => !s.startsWith('--desktop-render-check=')), '--desktop-render-check=https://example.com']), /Unknown/)
  assert.throws(() => renderCheckConfig(args.map(s => s.replace('=/tmp/bundle','=relative'))), /absolute/)
  assert.throws(() => renderCheckConfig([...args, '--desktop-render-check-query=x#outside']), /query/)
})

test('validation resources and bounded reports stay inside the private result directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'design-render-check-unit-'))
  try {
    const fixture = path.join(root, 'input.fd'), output = path.join(root, 'out')
    await writeFile(fixture, '{"nodes":{}}')
    const handler = renderCheckHandler({ fixture }, output, () => ({host:'electron'}))
    assert.deepEqual(await (await handler(new Request('design-app://app/__render_fixture'))).json(), {nodes:{}})
    assert.equal((await (await handler(new Request('design-app://app/__render_environment'))).json()).host, 'electron')
    assert.equal(await handler(new Request('https://app/__render_fixture')), undefined)
    assert.equal(await handler(new Request('design-app://other/__render_fixture')), undefined)
    assert.equal(await handler(new Request('design-app://app/__precision_image?name=../../outside', {method:'POST',body:'x'})), undefined)
    const post = body => handler(new Request('design-app://app/__render_report', {method:'POST',body}))
    await assert.rejects(post('{}'), /Invalid/)
    await assert.rejects(post('x'.repeat(4*1024*1024+1)), /too large/)
    await Promise.all([post('{"status":"running"}'),post('{"status":"passed"}')])
    const names = (await readdir(output)).sort()
    assert.equal(names.length, 2)
    assert.equal(JSON.parse(await readFile(path.join(output, names.at(-1)))).status, 'passed')
    assert.equal(await renderCheckHandler(undefined, output, () => ({}))(new Request('design-app://app/__render_fixture')), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
