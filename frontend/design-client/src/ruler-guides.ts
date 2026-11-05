import type {DesignDocument,Point,RulerGuide} from './model'
import {apply,worldMatrix,scene,type SceneEntry} from './geometry'
export type WorldGuide={owner:string;guide:RulerGuide;from:Point;to:Point;page:boolean;editable:boolean}
export function guideOwner(doc:DesignDocument,id:string){return doc.nodes[id]||doc.pages.find(p=>p.id===id)}
export function worldGuides(doc:DesignDocument,page:string,entries:readonly SceneEntry[]=scene(doc,page)):WorldGuide[]{
  const result:WorldGuide[]=[],p=doc.pages.find(p=>p.id===page)
  for(const guide of p?.guides||[])result.push({owner:page,guide,from:guide.axis==='x'?{x:guide.position,y:0}:{x:0,y:guide.position},to:guide.axis==='x'?{x:guide.position,y:1}:{x:1,y:guide.position},page:true,editable:true})
  for(const entry of entries){const n=doc.nodes[entry.id];if(!n.guides?.length)continue
    const editable = !entry.locked && !n.instance && !n.instanceOrigin && !entry.ancestors.some(id => {
      const ancestor = doc.nodes[id]
      return ancestor.instance || ancestor.instanceOrigin
    })
    const matrix=entry.matrix
    for(const guide of n.guides){const a=guide.axis==='x'?{x:guide.position,y:0}:{x:0,y:guide.position},b=guide.axis==='x'?{x:guide.position,y:n.height}:{x:n.width,y:guide.position}
      result.push({owner:n.id,guide,from:apply(matrix,a),to:apply(matrix,b),page:false,editable})
    }
  }
  return result
}
export function guidePosition(doc:DesignDocument,owner:string,axis:'x'|'y',point:Point){
  const m=worldMatrix(doc,owner),det=m[0]*m[3]-m[1]*m[2],x=point.x-m[4],y=point.y-m[5]
  return axis==='x'?(m[3]*x-m[2]*y)/det:(-m[1]*x+m[0]*y)/det
}
