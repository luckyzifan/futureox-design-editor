import { expect, test } from 'vitest'
import { PreparedPacket, waitForPacket } from './prepared-packet'
import { RenderLaneStates } from './render-lane-state'

const certificate = { lane: 'canvas', revision: 3, options: '{}', settings: 'null' }
test('prepared bytes transfer exactly once and identity is immutable', () => {
  const bytes = new Uint8Array([1, 2]), packet = new PreparedPacket(certificate, bytes, () => true)
  expect(Object.isFrozen(packet.certificate)).toBe(true)
  expect(packet.consume()).toBe(bytes)
  expect(() => packet.consume()).toThrow('PREPARED_PACKET_CONSUMED')
})
test('stale revision or resource settings revoke receipt before any GPU ownership', () => {
  let current = true
  const packet = new PreparedPacket(certificate, new Uint8Array([1]), () => current)
  current = false
  expect(() => packet.consume()).toThrow('STALE_PREPARED_PACKET')
  expect(() => packet.consume()).toThrow('PREPARED_PACKET_CONSUMED')
})
test('cancellation after preparation discards CPU bytes without calling GPU disposal', () => {
  const signal = new AbortController(), packet = new PreparedPacket(certificate, new Uint8Array([1]), () => true, signal.signal)
  signal.abort()
  expect(() => packet.consume()).toThrow('PREVIEW_CANCELLED')
})
test('a cancelled shared waiter returns before the physical compile resolves', async () => {
  let release!: (bytes: Uint8Array) => void
  const physical = new Promise<Uint8Array>(resolve => { release = resolve }), signal = new AbortController()
  const rejected = expect(waitForPacket(physical, signal.signal)).rejects.toThrow('PREVIEW_CANCELLED')
  signal.abort(); await rejected
  release(new Uint8Array([4])); expect(await physical).toEqual(new Uint8Array([4]))
})
test('lane identity persists across owner switches and delayed preparation', async () => {
  const lanes = new RenderLaneStates(), canvas = lanes.get('canvas'), interaction = lanes.get('interaction')
  canvas.loadedRevision = 7; interaction.loadedRevision = 22
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve }).then(() => { canvas.loadedRevision++ })
  interaction.loadedRevision++
  release(); await pending
  expect(lanes.get('canvas')).toBe(canvas); expect(lanes.get('interaction')).toBe(interaction)
  expect(canvas.loadedRevision).toBe(8); expect(interaction.loadedRevision).toBe(23)
  expect(canvas.enginePromise).toBeUndefined()
})

test('receipt snapshots caller metadata rather than retaining a mutable certificate', () => {
  const source = { lane: 'canvas', revision: 1, options: '{"view":{"zoom":2}}', settings: '{"enabled":true}' }
  const packet = new PreparedPacket(source, new Uint8Array([1]), () => true)
  source.revision = 9; source.options = '{"view":{"zoom":99}}'; source.settings = 'null'
  expect(packet.certificate).toEqual({ lane: 'canvas', revision: 1, options: '{"view":{"zoom":2}}', settings: '{"enabled":true}' })
})
