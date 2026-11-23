// Pointer and metadata-decode half of the frame-split measurement.
// Imports the production camera and frame-metadata functions. WebGPU encode,
// present, Electron and Metal are not available in this process.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { zoomAt, screenToWorld, worldToScreen, wheelCamera } from '../src/canvas-camera.ts'
import { WheelCameraGesture } from '../src/wheel-camera-gesture.ts'
import { decodeFrameValue } from '../src/kernel/gpu/frame-wire.ts'
import { frameResource } from '../src/kernel/gpu/frame-resources.ts'

const view = { x: 12.25, y: -40.5, zoom: 1.25 }
const anchor = { x: 480, y: 320 }
const size = { width: 960, height: 640 }
const panEvent = { deltaX: 18, deltaY: -6, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false }
const zoomEvent = { deltaX: 0, deltaY: -24, deltaMode: 0, shiftKey: false, ctrlKey: true, metaKey: false }

export function pointerFrame() {
  const zoomed = zoomAt(view, 2.5, anchor)
  const world = screenToWorld(view, anchor)
  const stayed = screenToWorld(zoomed, anchor)
  const projected = worldToScreen(zoomed, stayed)
  const panned = wheelCamera(view, panEvent, size, anchor, false, false)
  const pinched = wheelCamera(view, zoomEvent, size, anchor, false, false)
  const gesture = new WheelCameraGesture()
  const gestured = gesture.update(view, { ...zoomEvent, isTrusted: false }, size, anchor, false, false)
  return { zoomed, world, stayed, projected, panned, pinched, gestured }
}

function series(warmup, samples, body) {
  for (let i = 0; i < warmup; i++) body()
  const values = []
  for (let i = 0; i < samples; i++) {
    const started = performance.now()
    body()
    values.push(performance.now() - started)
  }
  const ordered = [...values].sort((a, b) => a - b)
  return { samples: values, p50Ms: ordered[Math.floor(ordered.length / 2)], p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] }
}

export function measurePointer(samples = 31, warmup = 5) {
  const frame = pointerFrame()
  const timings = series(warmup, samples, () => pointerFrame())
  return {
    layer: 'typescript',
    functions: ['zoomAt', 'screenToWorld', 'worldToScreen', 'wheelCamera', 'WheelCameraGesture.update'],
    anchorError: Math.hypot(frame.stayed.x - frame.world.x, frame.stayed.y - frame.world.y),
    panDx: frame.panned.x - view.x,
    zoomChanged: frame.pinched.zoom !== view.zoom,
    timings,
    frame: { zoomed: frame.zoomed, panned: frame.panned, pinched: frame.pinched, gestured: frame.gestured, projected: frame.projected },
  }
}

export function metadataSlice(packet) {
  if (packet.length < 24) throw Error('truncated FGSC packet')
  const header = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  if (header.getUint32(0, true) !== 0x43534746) throw Error('packet is not FGSC')
  const metadataBytes = header.getUint32(8, true)
  const vertexFloats = header.getUint32(12, true)
  const curveFloats = header.getUint32(16, true)
  const resourceBytes = header.getUint32(20, true)
  const start = Math.ceil((24 + metadataBytes) / 4) * 4
  if (start + (vertexFloats + curveFloats) * 4 + resourceBytes !== packet.length) throw Error('FGSC length does not match header')
  return {
    metadata: packet.subarray(24, 24 + metadataBytes),
    geometry: packet.subarray(start, start + (vertexFloats + curveFloats) * 4),
    metadataBytes, vertexFloats, curveFloats, resourceBytes,
  }
}

export function decodePacketResources(packet) {
  const parts = metadataSlice(packet)
  const header = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const start = Math.ceil((24 + parts.metadataBytes) / 4) * 4
  let cursor = start + parts.geometry.byteLength
  const resources = []
  while (cursor < packet.length) {
    if (packet.length - cursor < 9) throw Error('truncated frame resource')
    const id = header.getUint32(cursor, true)
    const kind = packet[cursor + 4]
    const length = header.getUint32(cursor + 5, true)
    cursor += 9
    if (length > packet.length - cursor) throw Error('invalid frame resource length')
    resources.push(frameResource(id, kind, packet.subarray(cursor, cursor + length)))
    cursor += length
  }
  if (cursor !== packet.length) throw Error('frame resource cursor did not finish the packet')
  return resources
}

export function measurePacketDecode(packet, samples = 31, warmup = 5) {
  const parts = metadataSlice(packet)
  const decoded = decodeFrameValue(parts.metadata)
  const metadataMs = series(warmup, samples, () => decodeFrameValue(parts.metadata))
  const resources = decodePacketResources(packet)
  const resourceMs = series(warmup, samples, () => decodePacketResources(packet))
  const copy = series(warmup, samples, () => packet.slice())
  const kinds = {}
  for (const resource of resources) kinds[resource.kind] = (kinds[resource.kind] || 0) + 1
  return {
    layer: 'typescript',
    functions: ['decodeFrameValue', 'frameResource'],
    notRun: ['decodeScenePacket wasm scene plan', 'webgpu-upload', 'gpu-present'],
    metadataBytes: parts.metadataBytes,
    geometryBytes: parts.geometry.byteLength,
    resourceBytes: parts.resourceBytes,
    resources: resources.length,
    resourceKinds: kinds,
    view: decoded.view ?? null,
    metadataDecodeMs: metadataMs,
    resourceDecodeMs: resourceMs,
    packetCopyMs: copy,
  }
}

function medianReport() {
  const samples = Number(process.env.FRAME_SPLIT_SAMPLES || 31)
  const report = { pointer: measurePointer(samples, 5), notRun: ['hardware-webgpu', 'macos', 'metal', 'electron', 'official-desktop-fps', 'gpu-command-encode', 'gpu-present'] }
  if (process.env.FRAME_SPLIT_PACKET) {
    const packet = readFileSync(process.env.FRAME_SPLIT_PACKET)
    report.packet = measurePacketDecode(new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength), samples, 5)
  } else report.packet = { status: 'NOT_RUN', reason: 'FRAME_SPLIT_PACKET was not set' }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(medianReport(), null, 2))
}
