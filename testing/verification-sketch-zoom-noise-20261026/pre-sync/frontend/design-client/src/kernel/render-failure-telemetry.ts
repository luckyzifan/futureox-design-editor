import { failureAllocationFields, inheritFailureAllocation } from '../../../design-desktop/src/render-failure-allocation.mjs'
import { runtimeConfigurationFields, inheritRuntimeConfiguration } from '../../../design-desktop/src/render-runtime-configuration.mjs'
/** Content-free classifications only. Inspect exact known messages/classes, never
 * serialize arbitrary names, messages, stacks, cause chains or document values. */
export type RenderFailureTag = { failureStage?: number; failureCategory?: number; failureCode?: number; failureOriginCode?: number; failureBuildKind?: number }
// Stages: 0 unknown,1 request,2 load,3 derive,4 patch,5 compile,6 hydrate,
// 7 encode,8 submit,9 fence,10 present,11 fallback,12 graph,13 admission.
// Categories: 0 unknown,1 cancellation,2 unsupported,3 resource budget,
// 4 device lost,5 validation,6 protocol.
const tags = new WeakMap<object, RenderFailureTag>()
const known: readonly [string, number, number][] = [
 // Fixed native compiler literals only. These codes do not infer a cause for older unknown failures.
 ["GPU transform exceeds precision budget", 5, 119],
 ["Render options must be an object", 5, 120],
 ["Invalid GPU painter support policy", 5, 121],
 ["Invalid GPU painter capture-read policy", 5, 122],
 ["GPU painter capture reads require painter support", 5, 123],
 ["Ambiguous GPU region", 5, 124],
 ["Invalid prepare viewport bounds", 5, 125],
 ["Native capture is a canvas operation", 6, 126],
 ["Pixel preview uses complete-frame presentation", 6, 127],
 ["Load document first", 6, 128],
 ["Missing page", 5, 129],
 ["GPU effect support exceeds coordinate budget", 5, 130],
 ["Scene path budget exceeded", 3, 131],
 ["Composed transform exceeds precision budget", 5, 132],
 ["Effect expansion exceeds device coordinate budget", 5, 133],
 ["Nested effect expansion exceeds device coordinate budget", 5, 134],
 ["Scene sequence exhausted", 6, 135],
 ["Singular transform", 5, 80],
 ["Nonfinite composed transform", 5, 81],
 ["Composed inverse exceeds precision budget", 5, 82],
 ["Invalid image sampling geometry", 5, 83],
 ["Image coordinate bounds exceed integer range", 5, 84],
 ["Sampling coordinate field exceeds 64 MiB", 3, 85],
 ["Sampling coordinate allocation failed", 3, 86],
 ["Parameter field exceeds 64 MiB", 3, 87],
 ["Parameter field allocation failed", 3, 88],
 ["Nonfinite material parameter", 5, 89],
 ["Invalid analytic glass shape", 5, 90],
 ["Glass field region exceeds original geometry domain", 5, 91],
 ["Invalid GPU viewport", 5, 92],
 ["Invalid GPU tile viewport", 5, 93],
 ["GPU analytic interval program budget exceeded", 3, 94],
 ["Sampling coordinate size overflow", 5, 95],
 ["Parameter field horizontal bounds overflow", 5, 96],
 ["Parameter field vertical bounds overflow", 5, 97],
 ["Parameter field size overflow", 5, 98],
 ["Nonfinite sample coordinate", 5, 99],
 ["Non-finite image sampling coordinate", 5, 100],
 ["Exact blur radius must be in (0,2048]", 2, 101],
 ["Box filter radius exceeds 512 pixels", 2, 102],
 ["Gaussian sigma must be in [0,512]", 5, 103],
 ["Gaussian box radius exceeds 512 pixels", 2, 104],
 ["WebGPU 纹理尺寸超限", 5, 105],
 ["无效的材质参数纹理", 5, 106],
 ["Regional coverage requires an interval program", 6, 107],
 ["Coverage program unavailable", 6, 108],
 ["Resident coverage program is missing", 6, 109],
 ["GPU 纹理精度与文档色彩空间不一致", 5, 110],
 ["不支持的 GPU 命令版本", 2, 111],
 ["GPU 区域命令缺少输出矩形", 6, 112],
 ["无效的参数字段布局", 5, 113],
 ["空 GPU 表面", 5, 114],
 ["GPU frame abort is unavailable", 2, 115],
 ["Prefix scratch was not retired after frame abort", 5, 116],
 ["GPU device preview recovery failed", 4, 117],
 ["GPU device lost during preview recovery", 4, 118],
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
 for (const [key, max] of [['failureStage',13],['failureCategory',6],['failureCode',255],['failureOriginCode',7],['failureBuildKind',9]] as const) {
  const value = input[key]
  if ((next[key] === undefined || next[key] === 0) && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max) next[key] = value
 }
 tags.set(error,next); return error
}
/** Allocation-rejection snapshot already owned by this exact Error. Never read
 * renderer-global counters after recovery; never traverse exception causes or
 * invoke a payload getter. Availability=0 is not a claim that usage was zero. */
function failureBudgetFields(error: unknown): Record<string, number> {
 const missing = { failureBudgetAvailable: 0 }
 try {
  if (!object(error)) return missing
  const budget = Object.getOwnPropertyDescriptor(error, 'budgetDiagnostic')?.value
  if (!budget || typeof budget !== 'object') return missing
  const own = (name: string) => Object.getOwnPropertyDescriptor(budget, name)?.value
  const requested = own('requestedBytes'), working = own('workingBytes'), limit = own('budgetBytes')
  const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 17179869184
  if (!bytes(requested) || !bytes(working) || !bytes(limit) || !limit || requested <= limit - working) return missing
  const out: Record<string, number> = { failureBudgetAvailable: 1, failureRequestedBytes: requested,
   failureWorkingBytes: working, failureBudgetBytes: limit }
  const width = own('width'), height = own('height'), coherent = own('coherent')
  if (Number.isSafeInteger(width) && width > 0 && width <= 1e9 && Number.isSafeInteger(height) && height > 0 && height <= 1e9) {
   out.failureAllocationWidth = width; out.failureAllocationHeight = height
  }
  if (typeof coherent === 'boolean') out.failureCoherent = Number(coherent)
  return out
 } catch { return missing }
}
export function renderFailureFields(error: unknown): Record<string, number> & { failureCategory: number; failureCode: number; failureStage: number; errorClassCode: number } {
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
 const category = tagged?.failureCategory ?? exact?.failureCategory ?? 0
 return { ...(category === 3 ? { ...failureBudgetFields(error), ...runtimeConfigurationFields(error), ...failureAllocationFields(error) } : {}), failureCategory: category,
  ...(tagged?.failureOriginCode ? { failureOriginCode: tagged.failureOriginCode } : {}),
  ...(tagged?.failureBuildKind ? { failureBuildKind: tagged.failureBuildKind } : {}),
  failureCode: tagged?.failureCode ?? exact?.failureCode ?? 0, failureStage: tagged?.failureStage ?? 0, errorClassCode }
}
export function inheritRenderFailure<T>(source: unknown, target: T): T {
 return markRenderFailure(inheritFailureAllocation(source,inheritRuntimeConfiguration(source,target)),renderFailureFields(source))
}
export function withRenderFailureStage<T>(stage: number, work: () => T): T {
 try {
  const result = work()
  if (result instanceof Promise) return result.catch(error => { throw markRenderFailure(error,{failureStage:stage}) }) as T
  return result
 } catch (error) { throw markRenderFailure(error,{failureStage:stage}) }
}
/** Type only; never coerce/read a thrown primitive or arbitrary object. */
export function renderFailureThrownKind(value: unknown): number {
 try { if (value instanceof Error) return 1 } catch { /* hostile class boundary */ }
 if (value === null) return 5
 return ({ string:2, number:3, boolean:4, undefined:6, object:7, function:8, symbol:9, bigint:10 })[typeof value] ?? 0
}
/** A fixed-size per-request counter. It retains no exception/content references.
 * Errors handled by fallback remain observable without one log per tile/pass. */
export class RenderFailureAttempts {
 private counts = new Uint16Array(14)
 private errors = 0
 private lastBoundary = 0
 private lastThrownKind = 0
 private last = { failureCategory:0, failureStage:0, failureCode:0, errorClassCode:0 }
 observe(error:unknown,stage?:number) { this.lastBoundary=Number.isInteger(stage)&&stage!>=1&&stage!<=13?stage!:0;this.lastThrownKind=renderFailureThrownKind(error);if(stage!==undefined)markRenderFailure(error,{failureStage:stage});this.errors=Math.min(65535,this.errors+1);this.last=renderFailureFields(error) }
 run<T>(stage:number, work:()=>T):T {
  if (Number.isInteger(stage) && stage>=1 && stage<=13) this.counts[stage]=Math.min(65535,this.counts[stage]+1)
  const failed=(error:unknown)=>{this.observe(error,stage);throw error}
  try { const result=withRenderFailureStage(stage,work);return result instanceof Promise ? result.catch(failed) as T : result }
  catch(error){return failed(error)}
 }
 fields() { return { compileAttempts:this.counts[5], hydrateAttempts:this.counts[6], graphAttempts:this.counts[12],
   fallbackAttempts:this.counts[11], failureAttempts:this.errors, failureCountsCapped:this.errors===65535 || this.counts.some(n=>n===65535), lastFailureStage:this.last.failureStage,
   lastFailureCategory:this.last.failureCategory, lastFailureCode:this.last.failureCode,
   lastFailureBoundaryStage:this.lastBoundary,lastFailureThrownKind:this.lastThrownKind,lastFailureClassCode:this.last.errorClassCode } }
}
