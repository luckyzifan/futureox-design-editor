import { expect, test } from 'vitest'
import { blank, node, paint } from './model'
import { createClip, recordKeyframe, pruneAnimations, PlaybackClock, easeInOut } from './animation'
test('whole-board motion records selected roots without thousands of static descendant tracks', () => {
  const d = blank(), roots = Array.from({ length: 3 }, () => node('frame'))
  for (const root of roots) {
    d.nodes[root.id] = root; d.pages[0].children.push(root.id)
    for (let i = 0; i < 752; i++) { const child = node('rectangle'); d.nodes[child.id] = child; root.children.push(child.id) }
  }
  const clip = createClip(d, d.pages[0].id, roots.map(r => r.id), false)
  expect(clip.tracks).toHaveLength(3)
  roots[0].transform[4] = 80
  recordKeyframe(d, clip, [roots[0].id], 1000, { kind: 'named', name: 'ease-out-quint' }, false)
  expect(clip.tracks).toHaveLength(3)
  expect(clip.tracks.find(t => t.nodeId === roots[0].id)?.keyframes[1].value.transform[4]).toBe(80)
})
test('recorded subtrees are immutable and replacing a keyframe does not duplicate its timestamp', () => {
  const d = blank(),
    g = node('group', 0, 0, 100, 100),
    r = node('rectangle', 10, 20, 30, 40)
  d.nodes[g.id] = g
  d.nodes[r.id] = r
  g.children = [r.id]
  d.pages[0].children = [g.id]
  d.animations = [createClip(d, d.pages[0].id, [g.id, r.id])]
  const c = d.animations[0]
  expect(c.tracks).toHaveLength(2)
  r.transform[4] = 80
  r.fills = [paint('#dd4488')]
  recordKeyframe(d, c, [r.id], 1000, easeInOut)
  const track = c.tracks.find((t) => t.nodeId === r.id)!
  expect(track.keyframes).toHaveLength(2)
  expect(track.keyframes[0].value.transform[4]).toBe(10)
  expect(track.keyframes[1].value.transform[4]).toBe(80)
  recordKeyframe(d, c, [r.id], 500, { kind: 'linear' })
  expect(track.keyframes.map((k) => k.timeMs)).toEqual([0, 500, 1000])
  delete d.nodes[r.id]
  g.children = []
  pruneAnimations(d)
  expect(d.animations[0].tracks.map((t) => t.nodeId)).toEqual([g.id])
})
test('playback pause, seek, resume and speed changes preserve absolute elapsed time', () => {
  const c = new PlaybackClock()
  c.play(100)
  expect(c.value(350)).toBe(250)
  c.pause(350)
  expect(c.value(900)).toBe(250)
  c.play(1000)
  c.speed(2, 1100)
  expect(c.value(1200)).toBe(550)
  c.seek(125, 1300)
  expect(c.value(1350)).toBe(225)
  c.pause(1400)
  expect(c.value(2000)).toBe(325)
  expect(() => c.speed(0, 0)).toThrow()
})
