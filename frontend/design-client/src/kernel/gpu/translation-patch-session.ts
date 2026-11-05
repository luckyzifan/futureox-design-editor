import type { DesignDocument, Matrix } from '../../model'
import type { GpuScene, Rect } from './types'
import { sceneIndex } from './scene-index'
import { previewTranslationDelta, translatePreviewOffsets, stableAncestorEffects } from './translated-scene'

/** One immutable document/geometry lease. Validate structural dependencies
 * once; pointer samples contain absolute translations only. Two node tables
 * separate the displayed scene from the next scene while its GPU work awaits. */
export class TranslationPatchSession {
  private descendants = new Map<string, string[]>()
  private ancestors = new Map<string, string[]>()
  private touched = new Set<string>()
  private buffers?: [GpuScene['nodes'], GpuScene['nodes']]
  private latest: Record<string, Matrix>
  private materialized?: DesignDocument
  private current: GpuScene
  readonly selected: readonly string[]
  get affectedNodes() { return this.touched.size }
  get changedNodes(): ReadonlySet<string> { return this.touched }
  private constructor(scene:GpuScene,private document:DesignDocument,ids:readonly string[]) {
    this.current=scene;this.selected=[...ids]
    this.latest=Object.fromEntries(ids.map(id=>[id,[...document.nodes[id].transform] as Matrix]))
  }
  static create(scene:GpuScene,document:DesignDocument,ids:readonly string[], exact = false):TranslationPatchSession|null {
    if(!ids.length||ids.length>16||new Set(ids).size!==ids.length||scene.softwareRaster||document.animations?.length||
      Object.values(scene.nodes).some(n=>n.captureReplay||n.textureReplay))return null
    const index=sceneIndex(scene),parents=index.parents
    const constraintsStable=(id:string)=>{
      const node=document.nodes[id],constraint=node?.constraints,parentId=parents.get(id)
      if(!constraint)return true
      if(!parentId)return index.roots.has(id)
      const parent=document.nodes[parentId],compiled=scene.nodes[parentId]
      return !!parent&&!!compiled&&(constraint.referenceWidth??parent.width)===parent.width&&
        (constraint.referenceHeight??parent.height)===parent.height&&compiled.size[0]===parent.width&&compiled.size[1]===parent.height
    }
    const unsupported=(id:string)=>{
      const node=document.nodes[id]
      return !node||!scene.nodes[id]||node.instance||node.instanceOrigin||node.component||node.componentSet||node.componentKey||
        Object.keys(node.variableModes||{}).length||node.layout&&node.layout.mode!=='none'||Object.keys(node.bindings||{}).length||!constraintsStable(id)
    }
    const ancestors=new Map<string,string[]>(),descendants=new Map<string,string[]>(),touched=new Set<string>()
    for(const id of ids){
      if(unsupported(id))return null
      const chain:string[]=[]
      if(!index.roots.has(id)){
        if(document.nodes[id].mask)return null
        let parent=parents.get(id)
        if(!parent)return null
        while(parent){
          const node=document.nodes[parent],compiled=scene.nodes[parent]
          if(unsupported(parent)||node.mask||compiled.maskId||!exact&&!stableAncestorEffects(node))return null
          chain.push(parent);parent=parents.get(parent)
        }
      }
      const stack=[id],children:string[]=[]
      while(stack.length){const child=stack.pop()!,node=scene.nodes[child];if(!node)continue;children.push(child);stack.push(...node.children)}
      ancestors.set(id,chain);descendants.set(id,children)
      for(const child of [...chain,...children])touched.add(child)
    }
    if(ids.some(id=>[...ancestors.values()].some(chain=>chain.includes(id))))return null
    const result=new TranslationPatchSession(scene,document,ids)
    result.ancestors=ancestors;result.descendants=descendants;result.touched=touched
    return result
  }
  prepare(scene:GpuScene,transforms:Record<string,Matrix>,window:Rect):GpuScene|null {
    if(scene!==this.current||Object.keys(transforms).length!==this.selected.length)return null
    const offsets=new Map<string,[number,number]>(),parents=new Set<string>(),nested=new Set<string>()
    for(const id of this.selected){
      const transform=transforms[id],before=this.document.nodes[id].transform
      if(!Array.isArray(transform)||transform.length!==6||!transform.every(Number.isFinite)||
        transform.slice(0,4).some((value,i)=>value!==before[i]))return null
      if(transform.every((value,i)=>value===this.latest[id][i]))continue
      const delta=previewTranslationDelta(scene,id,transform)
      if(!delta)return null
      const chain=this.ancestors.get(id)!
      for(const parent of chain)parents.add(parent)
      for(const child of this.descendants.get(id)!){offsets.set(child,delta);if(chain.length)nested.add(child)}
    }
    const source={...scene,interactionWindow:window}
    if(!offsets.size)return source
    // Native poses compile their own scene and never call prepare. Only a
    // translated JS scene needs writable tables distinct from the displayed one.
    this.buffers ??= [{ ...scene.nodes }, { ...scene.nodes }]
    const nodes=scene.nodes===this.buffers[0]?this.buffers[1]:this.buffers[0]
    // Restore only the affected set from the displayed table before reusing
    // this scratch table; it may still contain values from two poses ago.
    for(const id of this.touched)nodes[id]=scene.nodes[id]
    return translatePreviewOffsets(source,offsets,parents,nested,nodes)
  }
  accept(scene:GpuScene,transforms:Record<string,Matrix>) {
    this.current=scene
    this.latest=Object.fromEntries(this.selected.map(id=>[id,[...transforms[id]] as Matrix]))
    this.materialized=undefined
  }
  snapshot():DesignDocument {
    return this.materialized??={...this.document,nodes:{...this.document.nodes,
      ...Object.fromEntries(this.selected.map(id=>[id,{...this.document.nodes[id],transform:this.latest[id]}]))}}
  }
}
