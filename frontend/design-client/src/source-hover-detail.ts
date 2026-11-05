import type {Point} from './model'
import type {SourceCanvasItem} from './desktop'
export type SourceHitQuery={documentId:string;stageId:string;rootId:string;point:Point;zoom:number;deep:boolean}
export type SourceHit={nodeId:string;corners:Point[]}
export type SourceHitReply={hit:SourceHit|null}
export type SourceHoverHub={
  pick?:(material:SourceCanvasItem,point:Point,zoom:number,deep:boolean)=>Promise<SourceHitReply|undefined>|undefined
  refresh?:()=>void
}
