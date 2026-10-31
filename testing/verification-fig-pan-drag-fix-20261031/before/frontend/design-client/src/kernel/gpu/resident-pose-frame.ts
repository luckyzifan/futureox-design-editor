import type { ResidentFrame } from './resident-presenter'
type Pose = { slot:number; input:NonNullable<ResidentFrame['input']>; bounds:{x:number;y:number;width:number;height:number} }

/** The resident slot already contains these pixels. A delayed UI frame must
 * not relabel them with an older pose or crop them to its older damage window. */
export function withResidentPose(frame:ResidentFrame,pose:Pose):ResidentFrame {
  if(!frame.interaction||!frame.items.some(item=>item.active&&item.tile.gpuTile===pose.slot)||
    frame.input&&(frame.input.owner!==pose.input.owner||frame.input.sequence>pose.input.sequence))return frame
  const {view}=frame,{bounds}=pose
  return {...frame,input:pose.input,items:frame.items.map(item=>item.tile.gpuTile===pose.slot
    ?{...item,clip:{left:bounds.x*view.zoom+view.x,top:bounds.y*view.zoom+view.y,width:bounds.width*view.zoom,height:bounds.height*view.zoom}}
    :item)}
}
