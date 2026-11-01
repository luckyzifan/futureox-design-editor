import type { Matrix } from '../model'
import type { Rect } from './gpu/types'

type Input = { scene: object; driver: object; texture: object | undefined; window: Rect; transforms: Record<string, Matrix> }
export function samePoseTransforms(a:Record<string,Matrix>,b:Record<string,Matrix>) {
  const ids=Object.keys(a)
  return ids.length>0&&ids.length<=16&&ids.length===Object.keys(b).length&&ids.every(id=>Object.hasOwn(b,id)&&
    Array.isArray(a[id])&&Array.isArray(b[id])&&a[id].length===6&&b[id].length===6&&
    Array.from(a[id]).every((value,i)=>Number.isFinite(value)&&Object.is(value,b[id][i])))
}
type Pose={slot:number;transforms:Record<string,Matrix>;terminal?:boolean;input:{sequence:number;owner?:unknown}}
/** Scheduling only: never authorizes a document commit or a different owner. */
export function terminalPoseDisposition(running:Pose,pending:Pose|undefined):'none'|'same'|'changed' {
  if(!pending?.terminal||pending.slot!==running.slot||typeof running.input.owner!=='string'||!running.input.owner||
    pending.input.owner!==running.input.owner||!Number.isSafeInteger(pending.input.sequence)||pending.input.sequence<=running.input.sequence)return 'none'
  return samePoseTransforms(running.transforms,pending.transforms)?'same':'changed'
}
/** One successful native capture only. Equality of input transforms is not
 * sufficient without the same scene, physical texture, device and draw window. */
export class ResidentPoseReuse {
  private value?: Input
  record(input: Input) {
    const ids = Object.keys(input.transforms)
    if (!input.texture || ![input.window.x,input.window.y,input.window.w,input.window.h].every(Number.isFinite) || input.window.w<=0 || input.window.h<=0 || !ids.length || ids.length > 16 || ids.some(id =>
      !Array.isArray(input.transforms[id]) || input.transforms[id].length !== 6 || !Array.from(input.transforms[id]).every(Number.isFinite))) {
      this.value = undefined; return
    }
    this.value = { ...input, window: { ...input.window },
      transforms: Object.fromEntries(ids.map(id => [id, [...input.transforms[id]] as Matrix])) }
  }
  matches(input: Input) {
    const old = this.value
    if (!old || !input.texture || old.texture !== input.texture || old.scene !== input.scene || old.driver !== input.driver ||
      !(['x','y','w','h'] as const).every(key => Object.is(old.window[key],input.window[key]))) return false
    return samePoseTransforms(input.transforms,old.transforms)
  }
}
