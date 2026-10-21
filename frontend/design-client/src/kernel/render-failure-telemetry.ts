/** Content-free classifications only. Inspect exact known messages/classes, never
 * serialize arbitrary names, messages, stacks, cause chains or document values. */
export type RenderFailureTag = { failureStage?: number; failureCategory?: number; failureCode?: number }
// Stages: 0 unknown,1 request,2 load,3 derive,4 patch,5 compile,6 hydrate,
// 7 encode,8 submit,9 fence,10 present,11 fallback,12 graph,13 admission.
// Categories: 0 unknown,1 cancellation,2 unsupported,3 resource budget,
// 4 device lost,5 validation,6 protocol.
const tags = new WeakMap<object, RenderFailureTag>()
const known: readonly [string, number, number][] = [
 ['PREVIEW_CANCELLED',1,1], ['DERIVATION_UNSUPPORTED',2,2], ['DOCUMENT_PREPARATION_PENDING',6,3],
 ['STALE_PREPARED_PACKET',6,4], ['DERIVATION_RECEIPT_MISSING',6,5], ['STALE_BASE',6,6], ['STALE_TARGET',6,7],
 ['PATCH_GUARD_SCHEMA',5,61], ['STALE_AUTHORED_PATCH_BASE',6,62], ['PATCH_GUARD_UNSUPPORTED',2,63],
 ['DERIVE_SCHEMA',5,8], ['DERIVE_RETRY_REJECTED',6,9], ['DERIVATION_INVALID_ENVELOPE',5,10],
 ['DERIVATION_STALE_SOURCE',6,11], ['DERIVATION_FALLBACK_BUDGET',3,12], ['DERIVATION_FALLBACK_TIMEOUT',6,13],
 ['GPU surface budget exceeded',3,64], // Native compiler extent-area guard; not renderer byte admission.
 ['SEQUENTIAL_DISPLAY_UNSUPPORTED',2,65],
 ['GPU 表面内存预算超限',3,20], ['GPU 浮点图片内存预算超限',3,21], ['GPU 图片总内存预算超限',3,22],
 ['GPU 图集页内存预算超限',3,23], ['GPU 图片像素预算超限',3,24], ['GPU display resident budget exceeded',3,25],
 ['GPU linear display budget exceeded',3,26], ['GPU frame command work budget exceeded',3,27], ['GPU solid instance budget exceeded',3,28],
 ['WebGPU 设备已丢失',4,30], ['GPU 设备已丢失',4,31], ['GPU texture feedback loop',5,32],
 ['无效的 GPU 表面边界',5,33], ['无效的 GPU 图片资源',5,34], ['无效的 GPU 分配字节数',5,35],
 ['GPU exact blur radius exceeds 2048 pixels',2,40], ['GPU 积分模糊半径超过 512 像素',2,41],
 ['GPU 扩展半径超过 2048 像素',2,42], ['不支持的填充类型',2,43], ['渐变色标超过 32 个',2,44],
 ['Invalid CPU preparation request',6,50], ['CPU preparation response could not be decoded',6,51],
 ['CPU preparation request budget exceeded',3,52], ['Native preparation timed out',6,53],
 ['Invalid native preparation protocol',6,54], ['Native preparation sequence mismatch',6,55],
 ['文档补丁版本未同步，请重试当前画布',6,56], ['PREPARATION_SESSION_EXHAUSTED',6,57],
]
const codes = new Map(known.map(([message, category, code]) => [message, { failureCategory: category, failureCode: code }]))
const object = (error: unknown): error is object => (typeof error === 'object' && error !== null) || typeof error === 'function'
export function markRenderFailure<T>(error: T, input: RenderFailureTag): T {
 if (!object(error)) return error
 const previous = tags.get(error) || {}, next = { ...previous }
 for (const [key, max] of [['failureStage',13],['failureCategory',6],['failureCode',255]] as const) {
  const value = input[key]
  if ((next[key] === undefined || next[key] === 0) && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max) next[key] = value
 }
 tags.set(error,next); return error
}
export function renderFailureFields(error: unknown) {
 const tagged = object(error) ? tags.get(error) : undefined
 let errorClassCode = 0, exact: {failureCategory:number;failureCode:number} | undefined
 try {
  if (error instanceof Error) {
   errorClassCode = error instanceof SyntaxError ? 2 : error instanceof RangeError ? 3 : error instanceof TypeError ? 4 : 1
   if (typeof error.message === 'string' && error.message.length <= 256) exact = codes.get(error.message)
   if (!exact && error instanceof SyntaxError) exact={failureCategory:5,failureCode:60}
  } else if (typeof error === 'string' && error.length <= 256) exact = codes.get(error)
  const globals = globalThis as unknown as Record<string, unknown>
  for (const [name, klass, category] of [['GPUValidationError',5,5],['GPUOutOfMemoryError',6,3],['GPUInternalError',7,0]] as const) {
   const ctor = globals[name]
   if (typeof ctor === 'function' && error instanceof ctor) { errorClassCode = klass; exact ??= {failureCategory:category,failureCode:0}; break }
  }
 } catch { /* A hostile getter/class check yields explicit unknown, never text. */ }
 return { failureCategory: tagged?.failureCategory ?? exact?.failureCategory ?? 0,
  failureCode: tagged?.failureCode ?? exact?.failureCode ?? 0, failureStage: tagged?.failureStage ?? 0, errorClassCode }
}
export function inheritRenderFailure<T>(source: unknown, target: T): T {
 return markRenderFailure(target,renderFailureFields(source))
}
export function withRenderFailureStage<T>(stage: number, work: () => T): T {
 try {
  const result = work()
  if (result instanceof Promise) return result.catch(error => { throw markRenderFailure(error,{failureStage:stage}) }) as T
  return result
 } catch (error) { throw markRenderFailure(error,{failureStage:stage}) }
}
/** A fixed-size per-request counter. It retains no exception/content references.
 * Errors handled by fallback remain observable without one log per tile/pass. */
export class RenderFailureAttempts {
 private counts = new Uint16Array(14)
 private errors = 0
 private last = { failureCategory:0, failureStage:0, failureCode:0, errorClassCode:0 }
 observe(error:unknown,stage?:number) { if(stage!==undefined)markRenderFailure(error,{failureStage:stage});this.errors=Math.min(65535,this.errors+1);this.last=renderFailureFields(error) }
 run<T>(stage:number, work:()=>T):T {
  if (Number.isInteger(stage) && stage>=1 && stage<=13) this.counts[stage]=Math.min(65535,this.counts[stage]+1)
  const failed=(error:unknown)=>{this.observe(error);throw error}
  try { const result=withRenderFailureStage(stage,work);return result instanceof Promise ? result.catch(failed) as T : result }
  catch(error){return failed(error)}
 }
 fields() { return { compileAttempts:this.counts[5], hydrateAttempts:this.counts[6], graphAttempts:this.counts[12],
   fallbackAttempts:this.counts[11], failureAttempts:this.errors, failureCountsCapped:this.errors===65535 || this.counts.some(n=>n===65535), lastFailureStage:this.last.failureStage,
   lastFailureCategory:this.last.failureCategory, lastFailureCode:this.last.failureCode } }
}
