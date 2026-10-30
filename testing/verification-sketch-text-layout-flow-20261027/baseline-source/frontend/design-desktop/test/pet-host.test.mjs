import test from 'node:test'
import assert from 'node:assert/strict'
import { createPetHost } from '../src/pet/host.mjs'
import { createCompanionPolicy } from '../src/pet/companion-policy.mjs'
test('old backend cannot instantiate any window, session or runtime', () => {
  const trap = new Proxy({}, { get() { throw Error('Must not access Electron') } })
  const host = createPetHost(trap)
  for (const mode of ['active', 'quiet']) { const result = host.configure(mode); assert.equal(result.phase, 'unavailable'); assert.equal(result.ok, false); assert.equal(result.mode, 'off') }
  assert.equal(host.configure('off').ok, true); assert.equal(host.event('edit').accepted, false)
  assert.throws(() => host.configure('v1')); assert.throws(() => host.event({ text: 'document content' }))
  host.dispose(); assert.equal(host.configure('active').ok, false)
})
test('status revisions advance without stale ready/fallback claims', () => {
  const host = createPetHost(), sent = []; host.attachEditor({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } })
  host.configure('active'); host.configure('off'); assert.equal(sent[0][1].phase, 'unavailable'); assert.ok(sent[1][1].revision > sent[0][1].revision)
  host.dispose(); host.configure('quiet'); assert.equal(sent.length, 2)
})
test('bubbles are event only, bounded, quiet, and ignore arbitrary payloads', () => {
  let time = 0; const p = createCompanionPolicy({ now: () => time })
  assert.equal(p.cue('edit'), null); p.configure('active'); const a = p.cue('edit'); assert.equal(a.expiresAt, 8000)
  for (let i = 0; i < 1000; i++) assert.equal(p.cue('move'), null)
  time = 12000; assert.ok(p.cue('zoom')); time += 12000; assert.ok(p.cue('pet'))
  assert.equal(p.cue({ event: 'pet', secret: 'doc' }), null); assert.equal(p.cue('__proto__'), null)
  p.configure('quiet'); time += 12000; assert.equal(p.cue('click'), null)
  p.configure('active'); p.visibility(false); assert.equal(p.cue('click'), null)
  p.visibility(true); assert.ok(p.cue('click')); p.dispose(); time += 12000; p.configure('active'); assert.equal(p.cue('edit'), null)
})
test('idle needs 90 seconds of actual inactivity and never queues work', () => {
  let time = 0; const p = createCompanionPolicy({ now: () => time }); p.configure('active')
  time = 89999; assert.equal(p.cue('idle'), null); time++; assert.ok(p.cue('idle'))
  time += 5000; assert.equal(p.cue('idle'), null); p.cue('move'); time += 85000; assert.equal(p.cue('idle'), null); time += 5000; assert.ok(p.cue('idle'))
})
