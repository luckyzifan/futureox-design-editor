import type { PathMesh, Rect } from './types'

type Area = NonNullable<PathMesh['area']>
type Header = { kind: 3 | 4 | 5; width: number; height: number }
type Binding = Header & { count: number; residentFirst: number }
const MAX_SPAN_WORK = 262144

/** Driver-private proof of the actual resident words, not a node/scene hint.
 * Cached format checks follow only the existing bounded arena's ArrayBuffer.
 * No source array, pixels, document or retired GPU buffer is retained. */
export class SampleOnlyAreaPrograms {
  private arena?: ArrayBufferLike
  private arenaOffset = 0
  private formats = new Map<string, Header | false>()
  private bindings = new Map<number, Binding>()
  private buffer?: object
  private epoch = 0

  resetFrame() { this.bindings.clear(); this.buffer = undefined; this.epoch = 0 }
  reset() { this.resetFrame(); this.formats.clear(); this.arena = undefined; this.arenaOffset = 0 }

  bind(words: Uint32Array, offsets: ReadonlyMap<number, number>, paths: readonly Area[], buffer: object, epoch: number) {
    this.resetFrame()
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !(words.buffer instanceof ArrayBuffer) || words.length > 16 * 1024 * 1024) return
    if (this.arena !== words.buffer || this.arenaOffset !== words.byteOffset) {
      this.formats.clear(); this.arena = words.buffer; this.arenaOffset = words.byteOffset
    }
    this.buffer = buffer; this.epoch = epoch
    // Inspect the exact arena data supplied to queue.writeBuffer (or an
    // already-uploaded unchanged arena entry), after resident relocation.
    const values = new Float32Array(words.buffer, words.byteOffset, words.length)
    for (const area of paths) {
      const first = offsets.get(area.first)
      if (!Number.isSafeInteger(area.first) || area.first < 0 || !Number.isSafeInteger(area.count) || area.count < 1 ||
          !Number.isSafeInteger(first) || first! < 0 || (first! + area.count) * 4 > words.length) continue
      const key = `${first}:${area.count}`
      let header = this.formats.get(key)
      if (header === undefined) {
        if (this.formats.size >= 8192) continue
        header = sampleHeader(values, first!, area.count) || false
        this.formats.set(key, header)
      }
      if (header) this.bindings.set(area.first, { ...header, count: area.count, residentFirst: first! })
    }
  }

  accepts(path: PathMesh, sampleIndex: number | undefined, region: Rect, residentFirst: number | undefined,
    buffer: object | undefined, epoch: number): boolean {
    const area = path.area, r = path.rect
    if (!area || !path.count || path.sampleCount !== 4 || !Number.isInteger(sampleIndex) || sampleIndex! < 0 || sampleIndex! > 3 ||
        !buffer || buffer !== this.buffer || epoch !== this.epoch ||
        ![r.x, r.y, r.w, r.h, region.x, region.y, region.w, region.h].every(Number.isSafeInteger) ||
        r.w < 1 || r.h < 1 || r.w > 8192 || r.h > 8192 || region.w < 1 || region.h < 1 || region.w > 16384 || region.h > 16384 ||
        Math.abs(region.x - r.x) > 1048576 || Math.abs(region.y - r.y) > 1048576) return false
    const proof = this.bindings.get(area.first)
    return !!proof && proof.count === area.count && proof.residentFirst === residentFirst &&
      proof.width === r.w && proof.height === r.h
  }
}

function sampleHeader(values: Float32Array, first: number, count: number): Header | undefined {
  const begin = first * 4, end = (first + count) * 4, kind = values[begin], width = values[begin + 2], height = values[begin + 3]
  if (!(kind === 3 || kind === 4 || kind === 5) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192) return
  const pair = (at: number) => {
    for (let i = 0; i < 4; i++) if (!Number.isInteger(values[at + i]) || values[at + i] < 0 || values[at + i] > 65535) return false
    // Native endpoints are finite binary64 signed remainders; preserve zeros.
    return ((values[at + 3] >>> 4) & 2047) !== 2047
  }
  if(kind===5){
    const table=4+4*height
    if(width>2047||values[begin+1]!==1||begin+table>end)return
    const stride=width+1
    const span=(v:number,previous:number)=>{
      if(!Number.isSafeInteger(v)||v<0)return -1
      const left=Math.floor(v/stride),right=v%stride
      return left>=previous&&left<right&&right<=width?right:-1
    }
    let work=0
    for(let row=begin+4;row<begin+table;row++){
      const value=values[row]
      if(value===0||value===-1)continue
      if(!Number.isSafeInteger(value))return
      if(value<0){if(span(-value-2,0)<0)return;continue}
      const at=begin+value,n=values[at]
      if(value<table||!Number.isSafeInteger(n)||n<2||at+n>=end||(work+=n)>MAX_SPAN_WORK)return
      let previous=0
      for(let i=1;i<=n;i++){previous=span(values[at+i],previous);if(previous<0)return}
    }
    return {kind,width,height}
  }
  const range = (at: number) => Number.isSafeInteger(values[at]) && Number.isSafeInteger(values[at + 1]) &&
    Math.abs(values[at]) <= 1048576 && Math.abs(values[at + 1]) <= 1048576 && values[at] <= values[at + 1] &&
    (values[at + 2] === 0 || values[at + 2] === 1) && (values[at + 3] === 0 || values[at + 3] === 1)
  if (kind === 4) {
    if (count !== 7 || values[begin + 1] !== 0 || !range(begin + 4) || !range(begin + 8) ||
        ![begin + 12, begin + 16, begin + 20, begin + 24].every(pair)) return
    return { kind, width, height }
  }
  const table = 1 + height * 4
  if (values[begin + 1] !== 1 || count < table) return
  let work = 0
  for (let row = 0; row < height * 4; row++) {
    const at = begin + 4 + row * 4, start = values[at], spans = values[at + 1]
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(spans) || start < 0 || spans < 0 ||
        values[at + 2] !== 0 && values[at + 2] !== 1 || values[at + 2] === 1 && spans !== 1 ||
        values[at + 3] !== 0 || spans && start < table ||
        begin + (start + spans * 3) * 4 > end || (work += spans) > MAX_SPAN_WORK) return
    let previousLow = -Infinity, previousHigh = -Infinity
    for (let span = 0; span < spans; span++) {
      const offset = begin + (start + span * 3) * 4
      if (!range(offset) || values[offset] < previousLow || values[offset + 1] < previousHigh || !pair(offset + 4) || !pair(offset + 8)) return
      previousLow = values[offset]; previousHigh = values[offset + 1]
    }
  }
  return { kind, width, height }
}
