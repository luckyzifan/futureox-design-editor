import {admitSketchDisplay} from './sketch-display-contract.mjs'
/** Narrow CPU-only gate: v7 solid or same-RGB alpha-only axis-linear area paints. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
const bad = () => { throw new Error('Unsupported or malformed Sketch preview scene') }
const is = (condition) => { if (!condition) bad() }
function record(value, keys) {
  is(value && typeof value === 'object' && !Array.isArray(value))
  is(Object.keys(value).every(key => keys.includes(key)))
  return value
}
function number(value, max = 1e7, min = -max) { is(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max); return value }
function integer(value, max, min = 0) { number(value, max, min); is(Number.isInteger(value)); return value }
function tuple(value, length, max = 1e7) { is(Array.isArray(value) && value.length === length); value.forEach(v => number(v, max)); return value }
function empty(value) { is(Array.isArray(value) && value.length === 0) }
function name(value) { is(typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)); return value }
function rect(value) {
  record(value, ['x', 'y', 'w', 'h']); integer(value.x, 512); integer(value.y, 384)
  integer(value.w, 512); integer(value.h, 384); is(value.x + value.w <= 512 && value.y + value.h <= 384)
  return value
}
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
function remainder(data, at) {
  const bytes = new DataView(new ArrayBuffer(8))
  for (let n = 0; n < 4; n++) bytes.setUint16(n * 2, integer(data[at + n], 65535), true)
  number(bytes.getFloat64(0, true), 0.5)
}
function span(data, at, axis = 512) {
  integer(data[at], axis); integer(data[at + 1], axis); is(data[at] <= data[at + 1])
  integer(data[at + 2], 1); integer(data[at + 3], 1)
  remainder(data, at + 4); remainder(data, at + 8)
}
function area(data, start, count, bounds) {
  integer(start, data.length / 4); integer(count, data.length / 4, 1)
  is((start + count) * 4 <= data.length)
  const d = data.slice(start * 4, (start + count) * 4)
  is(d[2] === bounds.w && d[3] === bounds.h)
  if (d[0] === 1) {
    is(d[1] === 0 && count === 7)
    // Rectangle layout stores x/y ranges before their four f64 remainders.
    span([...d.slice(4, 8), ...d.slice(12, 20)], 0)
    span([...d.slice(8, 12), ...d.slice(20, 28)], 0, 384)
    return
  }
  is(d[0] === 0 && d[1] === 1)
  const header = 1 + bounds.h * 8
  is(count >= header)
  let spans = 0
  for (let row = 1; row < header; row++) {
    const at = row * 4, first = integer(d[at], count), n = integer(d[at + 1], 2048)
    is(d[at + 2] === 0 && d[at + 3] === 0)
    is(!n || (first >= header && first + n * 3 <= count))
    spans += n; is(spans <= 16384)
    for (let index = 0; index < n; index++) span(d, (first + index * 3) * 4)
  }
}
function alphaLinear(paint, node, colors) {
  is(!Object.hasOwn(paint, 'constantColor'))
  const t = tuple(paint.transform, 6, 1), [dx, dy, cross, repeat, x, y] = t
  is((dx === 0) !== (dy === 0)); is(cross === -dy && repeat === dx)
  number(x, 1, 0); number(y, 1, 0); number(x + dx, 1, 0); number(y + dy, 1, 0)
  const determinant = dx * dx + dy * dy
  is(determinant >= 1e-12)
  is(node.size[0] > 0 && node.size[1] > 0)
  is(node.inverse[4] === -node.matrix[4] && node.inverse[5] === -node.matrix[5])
  is(Array.isArray(paint.stops) && paint.stops.length >= 2 && paint.stops.length <= 16)
  let previous = -1, rgb
  for (const stop of paint.stops) {
    record(stop, ['offset', 'color']); number(stop.offset, 1, 0); is(stop.offset > previous); previous = stop.offset
    is(typeof stop.color === 'string' && Object.hasOwn(colors, stop.color))
    const color = colors[stop.color]
    if (rgb) is(color[0] === rgb[0] && color[1] === rgb[1] && color[2] === rgb[2])
    else rgb = color
  }
  is(paint.color === paint.stops[0].color)
  // Validate the shared FixedGradient wire coefficients; do not compile paints or render here.
  const fixed = record(paint.fixedGradient, ['bits', 'words'])
  integer(fixed.bits, 52, 24)
  is(Array.isArray(fixed.words) && fixed.words.length === 3)
  const coefficients = fixed.words.map(words => {
    is(Array.isArray(words) && words.length === 4)
    let packed = 0n
    words.forEach((word, i) => { packed |= BigInt(integer(word, 65535)) << BigInt(i * 16) })
    return BigInt.asIntN(64, packed)
  })
  const abs = n => n < 0n ? -n : n
  is((abs(coefficients[0]) + abs(coefficients[1])) * 32768n * 8n + abs(coefficients[2]) * 8n < (1n << 61n))
  const a = dx / determinant, b = dy / determinant, offset = (-dy * y - dx * x) / determinant
  const m = node.inverse, size = node.size, scale = 2 ** fixed.bits
  const values = [m[0] / size[0] * a + m[1] / size[1] * b,
    m[2] / size[0] * a + m[3] / size[1] * b,
    m[4] / size[0] * a + m[5] / size[1] * b + offset]
  const tiesEven = value => { const floor = Math.floor(value), fraction = value - floor; return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1 }
  let error = 0
  values.forEach((value, i) => {
    const scaled = value * scale
    is(Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 61)
    is(coefficients[i] === BigInt(tiesEven(scaled)))
    error += Math.abs(value - Number(coefficients[i]) / scale) * (i < 2 ? 32768 : 1)
  })
  is(error <= 1e-8)
}
export function admitSketchPreview(frameJson, expectedOwner, expectedRevision = 0) {
  is(typeof frameJson === 'string' && frameJson.length <= MAX_PREVIEW_BYTES)
  is(new TextEncoder().encode(frameJson).length <= MAX_PREVIEW_BYTES)
  const frame = record(JSON.parse(frameJson), ['owner', 'revision', 'page_id', 'scene'])
  const owner = record(frame.owner, ['kernel_id', 'document_schema', 'document_id', 'session_epoch'])
  is(owner.kernel_id === 'sketch' && owner.document_schema === 'sketch-native-v1')
  name(owner.document_id); integer(owner.session_epoch, Number.MAX_SAFE_INTEGER, 1)
  is(['kernel_id', 'document_schema', 'document_id', 'session_epoch'].every(key => owner[key] === expectedOwner[key]))
  integer(expectedRevision, Number.MAX_SAFE_INTEGER); is(frame.revision === expectedRevision); name(frame.page_id)
  const s = record(frame.scene, ['softwareRaster','floatCompositing','colorManagement','colors','backdropSamples','coherentSamples','integratedBlur','curves','version','width','height','extent','background','transparent','grid','view','roots','nodes','vertices'])
  is(s.version === 7 && s.width === 512 && s.height === 384 && s.integratedBlur === true)
  is(s.softwareRaster === false && s.backdropSamples === false && s.coherentSamples === false && s.transparent === true && s.grid === false && s.background === '#00000000')
  is(sameRect(rect(s.extent), { x: 0, y: 0, w: 512, h: 384 }))
  record(s.view, ['x','y','zoom']); is(s.view.x === 0 && s.view.y === 0 && s.view.zoom === 1)
  // Explicit linearSrgbComposite previews stay managed. Encoded Sketch previews
  // omit colorManagement and must not be treated as that linear document.
  const linear = s.floatCompositing === true
  is(linear || s.floatCompositing === false)
  if (linear) {
    record(s.colorManagement, ['documentSpace','referenceWhiteNits','peakLuminanceNits'])
    is(s.colorManagement.documentSpace === 'srgb' && s.colorManagement.referenceWhiteNits === 203 && s.colorManagement.peakLuminanceNits === 1000)
  } else is(s.colorManagement == null)
  empty(s.vertices)
  is(Array.isArray(s.curves) && s.curves.length <= 262144 && s.curves.length % 4 === 0); s.curves.forEach(v => number(v))
  is(s.nodes && typeof s.nodes === 'object' && !Array.isArray(s.nodes))
  const ids = Object.keys(s.nodes); is(ids.length <= 128)
  is(Array.isArray(s.roots) && s.roots.length === ids.length && new Set(s.roots).size === ids.length)
  is(s.roots.every(id => typeof id === 'string' && Object.hasOwn(s.nodes, id)))
  const colors = s.colors || {}; is(colors && typeof colors === 'object' && !Array.isArray(colors) && Object.keys(colors).length <= 256)
  for (const [key, color] of Object.entries(colors)) { is(key.length < 256); tuple(color, 4, 1).forEach(v => is(v >= 0)) }
  let paintCount = 0
  for (const id of ids) {
    name(id)
    const n = record(s.nodes[id], ['opaqueCoverage','passthrough','backdropBox','id','rect','matrix','inverse','size','fill','fills','strokes','children','mask','maskType','clip','opacity','blend','effects'])
    is(n.id === id && n.opaqueCoverage === false && n.passthrough === false && n.mask === false && n.maskType === null && n.clip === false && n.blend === 'normal')
    is(tuple(n.backdropBox, 4).every(v => v === 0)); tuple(n.size, 2).forEach(v => is(v >= 0)); number(n.opacity, 1, 0)
    for (const matrix of [n.matrix, n.inverse]) { tuple(matrix, 6); is(matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 1) }
    const bounds = rect(n.rect); is(bounds.w > 0 && bounds.h > 0)
    empty(n.children); empty(n.effects); empty(n.strokes)
    const fill = record(n.fill, ['area','rect','first','count','rule']); is(sameRect(rect(fill.rect), bounds))
    is(fill.first === 0 && fill.count === 3 && ['nonzero','evenodd'].includes(fill.rule))
    record(fill.area, ['first','count']); area(s.curves, fill.area.first, fill.area.count, bounds)
    is(Array.isArray(n.fills) && n.fills.length > 0 && n.fills.length <= 32)
    paintCount += n.fills.length; is(paintCount <= 256)
    for (const paint of n.fills) {
      record(paint, ['id','kind','color','opacity','visible','angle','stops','image','fit','blend','constantColor','figmaGradient','transform','fixedGradient'])
      is(typeof paint.id === 'string' && paint.id.length <= 256 && ['solid', 'linear'].includes(paint.kind) && paint.visible === true && paint.angle === 0 && paint.image === null && paint.fit === 'cover' && paint.blend === 'normal' && paint.figmaGradient === false)
      is(typeof paint.color === 'string' && Object.hasOwn(colors, paint.color))
      number(paint.opacity, 1, 0)
      if (paint.kind === 'solid') {
        is(paint.constantColor === paint.color && !Object.hasOwn(paint, 'transform') && !Object.hasOwn(paint, 'fixedGradient')); empty(paint.stops)
      } else alphaLinear(paint, n, colors)
    }
  }
  // JSON parsing detached all data from the IPC caller. No live document is returned.
  return frame
}

/** Bind ready and unsupported outcomes to the requested live-session snapshot. */
export function admitSessionPreview(value, owner, revision, pageId) {
  is(value && typeof value === 'object' && value.owner)
  is(['kernel_id', 'document_schema', 'document_id', 'session_epoch'].every(key => value.owner[key] === owner[key]))
  integer(revision, Number.MAX_SAFE_INTEGER); is(value.revision === revision)
  integer(value.pageCount, 100, 1); name(pageId); is(value.pageId === pageId)
  const p = value.preview
  let preview
  if(p?.status==='display'){
    const snapshot=admitSketchDisplay(p.snapshot,owner,revision);is(snapshot.pageId===pageId&&p.pageId===pageId&&typeof p.pageName==='string'&&p.pageName.length<=800);preview={status:'display',snapshot,pageId,pageName:p.pageName}
  }else if (p?.status === 'ready') {
    const frame = admitSketchPreview(p.frameJson, owner, revision)
    is(frame.page_id === pageId && p.pageId === pageId && typeof p.pageName === 'string' && p.pageName.length <= 800)
    preview = { status: 'ready', frameJson: p.frameJson, pageId, pageName: p.pageName }
  } else {
    is(p?.status === 'unavailable' && typeof p.reason === 'string' && p.reason.length <= 4096)
    preview = { status: 'unavailable', reason: p.reason }
  }
  return { owner: { ...owner }, revision, pageId, pageCount: value.pageCount, preview }
}
