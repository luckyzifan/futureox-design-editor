import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ACTIONS, boundedDpr, createScheduler, normalizeState } from '../src/pet/renderer/scheduler.mjs';

function harness() {
  let serial = 0;
  const pending = new Map();
  const paints = [];
  let clears = 0;
  const scheduler = createScheduler({
    requestFrame(callback) { pending.set(++serial, callback); return serial; },
    cancelFrame(handle) { pending.delete(handle); },
    draw(value) { paints.push(value); },
    clear() { clears++; },
  });
  function tick(now) {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach(callback => callback(now));
  }
  return { scheduler, pending, paints, tick, get clears() { return clears; } };
}
const active = (sequence, action = 'idle') => ({ mode: 'active', paused: false, action, sequence });

test('semantic whitelist and sequence validation fail closed', () => {
  assert.equal(normalizeState({ ...active(0), mode: 'surprise' }), null);
  assert.equal(normalizeState({ ...active(0), paused: 'false' }), null);
  assert.equal(normalizeState(active(-1)), null);
  assert.equal(normalizeState(active(Infinity)), null);
  assert.equal(normalizeState(active(1, '<script>')).action, 'idle');
  assert.deepEqual(ACTIONS, ['idle', 'work', 'nod', 'celebrate', 'puzzled', 'wave']);
});

test('DPR is bounded even for malformed input', () => {
  for (const [input, expected] of [[4, 1.5], [1.25, 1.25], [0, 1], [NaN, 1], [Infinity, 1]]) {
    assert.equal(boundedDpr(input), expected);
  }
});

test('hidden starts with no scheduling; active paints at most 30 FPS on high refresh', () => {
  const h = harness();
  h.scheduler.setState(active(0));
  assert.equal(h.pending.size, 0);
  h.scheduler.setVisible(true);
  for (let timestamp = 0; timestamp < 1000; timestamp += 1000 / 144) {
    h.tick(timestamp);
    assert.equal(h.pending.size, 1);
  }
  assert.ok(h.paints.length <= 30);
  assert.ok(h.paints.length >= 25);
  for (let i = 1; i < h.paints.length; i++) {
    assert.ok(h.paints[i].elapsed - h.paints[i - 1].elapsed >= 1000 / 30);
  }
});

test('quiet, paused, reduced-motion, off and hidden have zero pending callbacks', () => {
  const h = harness();
  h.scheduler.setVisible(true);
  h.scheduler.setState(active(1));
  h.tick(0);
  h.scheduler.setState({ ...active(2), mode: 'quiet' });
  assert.equal(h.pending.size, 0);
  assert.equal(h.paints.at(-1).staticFrame, true);
  const quietCount = h.paints.length;
  h.tick(100);
  assert.equal(h.paints.length, quietCount);
  h.scheduler.setState({ ...active(3), paused: true });
  assert.equal(h.pending.size, 0);
  h.scheduler.setState(active(4));
  h.scheduler.setReducedMotion(true);
  assert.equal(h.pending.size, 0);
  h.scheduler.setReducedMotion(false);
  assert.equal(h.pending.size, 1);
  h.scheduler.setVisible(false);
  assert.equal(h.pending.size, 0);
  const hiddenCount = h.paints.length;
  h.scheduler.invalidate();
  h.scheduler.setState(active(5, 'wave'));
  h.tick(200);
  assert.equal(h.paints.length, hiddenCount);
  h.scheduler.setVisible(true);
  h.scheduler.setState({ ...active(6), mode: 'off' });
  assert.equal(h.pending.size, 0);
  assert.ok(h.clears > 0);
});

test('state changes never multiply callbacks; stale events and disposal are inert', () => {
  const h = harness();
  h.scheduler.setVisible(true);
  for (let i = 0; i < 20; i++) {
    assert.equal(h.scheduler.setState(active(i, 'nod')), true);
    assert.equal(h.pending.size, 1);
  }
  assert.equal(h.scheduler.setState(active(18)), false);
  assert.equal(h.scheduler.setState(active(19)), false);
  h.scheduler.dispose();
  h.scheduler.dispose();
  assert.equal(h.pending.size, 0);
  h.scheduler.setVisible(false);
  h.scheduler.setVisible(true);
  h.scheduler.invalidate();
  assert.equal(h.scheduler.setState(active(20)), false);
  assert.equal(h.pending.size, 0);
  h.tick(500);
  assert.equal(h.paints.length, 0);
});

test('copied artwork and notices match pinned provenance hashes', () => {
  const root = new URL('../src/pet/renderer/assets/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8'));
  assert.equal(manifest.commit, '2d50d24dc0bae366d74918f90fe203e7a129a0b3');
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.destination, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.length, file.bytes);
  }
});
