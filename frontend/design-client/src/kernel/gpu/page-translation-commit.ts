import type { DesignDocument } from '../../model'
import type { DocumentPatch } from '../../document-patch'
import type { PaintDamage } from '../paint-damage'

/** Additional display-cache scope after the authoritative kernel accepted the
 * patch as translation-only. No independent document mutation or export proof.
 * Every visible page root must have the same displacement; a nested edit or
 * a change on another page cannot adopt a translated whole-page backbuffer. */
export function pageTranslationCommit(before:DesignDocument,next:DesignDocument,pageId:string,patch:DocumentPatch,damage:PaintDamage){
  if(damage.translationOnly!==true||before.id!==next.id||Object.keys(patch.fields).length||!Object.keys(patch.nodes).length)return
  const page=before.pages.find(page=>page.id===pageId),after=next.pages.find(page=>page.id===pageId)
  if(!page||!after||page.children.length!==after.children.length||page.children.some((id,i)=>id!==after.children[i])||
    Object.keys(patch.nodes).some(id=>!page.children.includes(id)))return
  let offset:{x:number;y:number}|undefined
  for(const id of page.children){
    const a=before.nodes[id],b=next.nodes[id]
    if(!a||!b||a.visible!==b.visible)return
    if(!a.visible)continue
    if(a.transform.slice(0,4).some((value,i)=>!Object.is(value,b.transform[i]))||
      [4,5].some(i=>a.transform[i]===b.transform[i]&&!Object.is(a.transform[i],b.transform[i])))return
    const delta={x:b.transform[4]-a.transform[4],y:b.transform[5]-a.transform[5]}
    if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y)||offset&&(offset.x!==delta.x||offset.y!==delta.y))return
    offset=delta
  }
  return offset&&(offset.x!==0||offset.y!==0)?offset:undefined
}
