import type { Matrix } from '../../model'
import { inverse, multiply } from '../../geometry'
import type { GpuScene } from './types'
import { sceneIndex } from './scene-index'
import type { ResidentFrame } from './resident-presenter'

type FrozenBasis = { world:Matrix; nodes:Map<string,{matrix:Matrix;parent:Matrix}>; bytes:number }
/** Small CPU pose metadata, never a retained scene, program or image payload.
 * A stopped mutable slot keeps its last compiled basis until display-release.
 * Optional admission is bounded; missing proof never falls back to identity. */
export class FrozenResidentOverlayPoses {
  private owner?:object
  private entries=new Map<number,FrozenBasis>()
  private bytes=0
  constructor(private readonly limit=64*1024) {}
  private bind(owner:object){if(owner!==this.owner){this.entries.clear();this.bytes=0;this.owner=owner}}
  release(slots:readonly number[]){for(const slot of slots){const entry=this.entries.get(slot);if(entry){this.bytes-=entry.bytes;this.entries.delete(slot)}}}
  freeze(owner:object,slot:number,scene:GpuScene):boolean {
    this.bind(owner);this.release([slot])
    const ids=scene.interactionSelection||[],parents=sceneIndex(scene).parents
    const camera:Matrix=[scene.view.zoom,0,0,scene.view.zoom,scene.view.x,scene.view.y]
    if(!Number.isSafeInteger(slot)||slot<=0||!ids.length||ids.length>16||new Set(ids).size!==ids.length||
        !camera.every(Number.isFinite)||camera[0]<=0)return false
    const nodes:FrozenBasis['nodes']=new Map();let bytes=128
    for(const id of ids){
      const node=scene.nodes[id],parentId=parents.get(id),parent=parentId?scene.nodes[parentId]?.matrix:camera
      if(!node||!parent||!node.matrix.every(Number.isFinite)||!parent.every(Number.isFinite))return false
      nodes.set(id,{matrix:[...node.matrix] as Matrix,parent:[...parent] as Matrix});bytes+=id.length*2+192
    }
    if(bytes>this.limit)return false
    while(this.bytes+bytes>this.limit)this.release([this.entries.keys().next().value!])
    this.entries.set(slot,{world:inverse(camera),nodes,bytes});this.bytes+=bytes;return true
  }
  resolve(owner:object,slot:number,transforms:Record<string,Matrix>):Record<string,Matrix>|undefined {
    this.bind(owner);const basis=this.entries.get(slot),ids=Object.keys(transforms)
    if(!basis||ids.length!==basis.nodes.size)return
    const result:Record<string,Matrix>={}
    for(const id of ids){
      const node=basis.nodes.get(id),transform=transforms[id]
      if(!node||transform.length!==6||!transform.every(Number.isFinite))return
      const authored=multiply(basis.world,multiply(node.parent,transform))
      if(Math.abs(authored[0]*authored[3]-authored[1]*authored[2])<1e-12)return
      const delta=multiply(multiply(basis.world,node.matrix),inverse(authored))
      if(!delta.every(Number.isFinite))return
      result[id]=delta
    }
    return result
  }
}

/** While an affine rebase is in flight the compiled texture is still the
 * previous pose. Forward chrome deltas would rotate the blue box before
 * those pixels move. Hold chrome on the texture until the replacement
 * capture publishes both together. */
export function stickyPresentedAffines<T>(affines: T | undefined, rebaseInFlight: boolean): T | undefined {
  return rebaseInFlight ? undefined : affines
}

/** The worker chooses the compiled basis belonging to the sampled slot.
 * A requested slot with no private proof must not draw untransformed chrome. */
export function resolveResidentOverlayFrame(frame:ResidentFrame,owner:object,
  active:{slot:number;scene:GpuScene}|undefined,frozen:FrozenResidentOverlayPoses){
  const transforms=frame.overlay?.transforms
  const slot=frame.overlayPoseSlot
  if(slot!==undefined){
    const included=frame.interaction&&frame.items.some(item=>item.active&&item.tile.gpuTile===slot)
    const result=included&&transforms?(active?.slot===slot?residentOverlayAffines(active.scene,transforms):frozen.resolve(owner,slot,transforms)):undefined
    if(!result||!transforms||!Object.keys(transforms).length||Object.keys(result).length!==Object.keys(transforms).length){frame.overlay=undefined;return}
    return result
  }
  if(!transforms||!active||!frame.interaction||!frame.items.some(item=>item.active&&item.tile.gpuTile===active.slot))return
  return residentOverlayAffines(active.scene,transforms)
}

/** Delta from authored world chrome to the already compiled resident pose. */
export function residentOverlayAffines(scene: GpuScene, transforms: Record<string, Matrix>): Record<string, Matrix> {
  const parents = sceneIndex(scene).parents, result: Record<string, Matrix> = {}
  const camera: Matrix = [scene.view.zoom, 0, 0, scene.view.zoom, scene.view.x, scene.view.y]
  if (!camera.every(Number.isFinite) || camera[0] <= 0) return result
  const world = inverse(camera)
  for (const [id, transform] of Object.entries(transforms)) {
    const node = scene.nodes[id], parentId = parents.get(id), parent = parentId ? scene.nodes[parentId]?.matrix : camera
    if (!node || !parent || !transform.every(Number.isFinite)) continue
    const authored = multiply(world, multiply(parent, transform))
    if (Math.abs(authored[0] * authored[3] - authored[1] * authored[2]) < 1e-12) continue
    const delta = multiply(multiply(world, node.matrix), inverse(authored))
    if (delta.every(Number.isFinite)) result[id] = delta
  }
  return result
}
