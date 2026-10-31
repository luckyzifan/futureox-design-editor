export function sameSketchOwner(a, b) {
  return !!a && !!b && ['kernel_id', 'document_schema', 'document_id', 'session_epoch'].every(k => a[k] === b[k])
}
export function admitSketchSession(value, owner) {
  const fail = () => { throw new Error('Invalid Sketch session reply') }
  if (!sameSketchOwner(value?.owner, owner) || typeof value.active !== 'boolean' || owner.kernel_id !== 'sketch' || owner.document_schema !== 'sketch-native-v1' ||
      typeof owner.document_id !== 'string' || !owner.document_id || owner.document_id.length > 128 || !Number.isSafeInteger(owner.session_epoch) || owner.session_epoch < 1 ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.savedRevision) || value.savedRevision < 0 || value.savedRevision > value.revision ||
      typeof value.saveUncertain !== 'boolean' || value.dirty !== (value.revision !== value.savedRevision || value.saveUncertain) || !['memory-only-unsaved', 'native-file-saved'].includes(value.persistence) ||
      !Number.isInteger(value.undoCount) || value.undoCount < 0 || value.undoCount > 32 || !Number.isInteger(value.redoCount) || value.redoCount < 0 || value.redoCount > 32 ||
      !Array.isArray(value.layers) || value.layers.length > 512 || typeof value.layersTruncated !== 'boolean') fail()
  const ids = new Set()
  const layers = value.layers.map(layer => {
    if (!layer || typeof layer.id !== 'string' || !layer.id || layer.id.length > 128 || ids.has(layer.id) || typeof layer.pageId !== 'string' || layer.pageId.length > 128 ||
        typeof layer.name !== 'string' || layer.name.length > 240 || !Number.isInteger(layer.depth) || layer.depth < 0 || layer.depth > 128) fail()
    ids.add(layer.id)
    return { id: layer.id, name: layer.name, pageId: layer.pageId, depth: layer.depth }
  })
  return { owner: { ...owner }, active: value.active, revision: value.revision, savedRevision: value.savedRevision, saveUncertain: value.saveUncertain, dirty: value.dirty, persistence: value.persistence,
    undoCount: value.undoCount, redoCount: value.redoCount, layers, layersTruncated: value.layersTruncated }
}
export function validSketchFrame(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 4 && ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 1e9) && value.width >= 0.5 && value.height >= 0.5
}
/** UTF-16 text bound and native ID/path envelope mirror the Sketch kernel. */
export function validSketchTextOverride(value) {
  const nativeId = id => typeof id === 'string' && !!id && new TextEncoder().encode(id).length <= 128 && !/[\u0000-\u001f\u007f-\u009f/]/u.test(id)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      !nativeId(value.instanceId) || typeof value.targetPath !== 'string' || value.targetPath.length > 64 * 129 - 1 || typeof value.text !== 'string' || value.text.length > 100_000) return false
  const path = value.targetPath.split('/')
  return path.length <= 64 && path.every(nativeId)
}
export function admitSketchLeafFrame(value, owner, revision, layerId) {
  if (!sameSketchOwner(value?.owner, owner) || value.revision !== revision || value.layerId !== layerId ||
      (value.frame === null ? typeof value.reason !== 'string' || value.reason.length > 4096 : !validSketchFrame(value.frame) || value.reason !== null)) throw new Error('Invalid or stale native frame reply')
  return { owner: { ...owner }, revision, layerId, frame: value.frame === null ? null : { x: value.frame.x, y: value.frame.y, width: value.frame.width, height: value.frame.height }, reason: value.reason }
}

function textQueryFence(value, owner, revision, instanceId) {
  if (!sameSketchOwner(value?.owner, owner) || value.revision !== revision || value.instanceId !== instanceId) throw new Error('Invalid or stale native text query reply')
}
export function admitSketchTextTargets(value, owner, revision, instanceId) {
  textQueryFence(value, owner, revision, instanceId)
  if (!Array.isArray(value.targets) || value.targets.length > 256) throw new Error('Invalid native text targets')
  let bytes = 0; const paths = new Set()
  const targets = value.targets.map(item => {
    if (!item || !validSketchTextOverride({ instanceId: item.layerId, targetPath: item.targetPath, text: '' }) || item.targetPath.split('/').at(-1) !== item.layerId || paths.has(item.targetPath)) throw new Error('Invalid native text target')
    paths.add(item.targetPath); bytes += 6 * new TextEncoder().encode(item.targetPath + item.layerId).length + 64
    if (bytes > 128 * 1024) throw new Error('Native text target response exceeds limit')
    return { targetPath: item.targetPath, layerId: item.layerId }
  })
  return { owner: { ...owner }, revision, instanceId, targets }
}
export function admitSketchTextValue(value, owner, revision, instanceId, targetPath) {
  textQueryFence(value, owner, revision, instanceId)
  if (value.targetPath !== targetPath || ![value.explicitText, value.masterText].every(v => v === null || typeof v === 'string' && v.length <= 100000)) throw new Error('Invalid native text value')
  return { owner: { ...owner }, revision, instanceId, targetPath, explicitText: value.explicitText, masterText: value.masterText }
}
