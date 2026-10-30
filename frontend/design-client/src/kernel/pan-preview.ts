import type {DesignDocument} from '../model'
import type {PresentedFrame} from './Surface'
import type {CompositeItem} from './gpu/tile-compositor'
export type PanPreviewBacking={document:DesignDocument;revision:number;pageId:string;epoch:number;
 residents:ReadonlyMap<string,CompositeItem['tile']>}

/** Only a same-content, same-output camera preview may expose still-unpainted
 * edge strips. Missing native coverage remains a preview, never terminal
 * quality. The caller's completed backing proves the page/session/device. */
export function allowIncompletePanPreview(input:{allowed?:boolean;frame:PresentedFrame|null;
 document:DesignDocument;revision:number;pageId:string;width:number;height:number;dpr:number;items:readonly CompositeItem[];backing?:PanPreviewBacking}){
 const f=input.frame
 const backing=input.backing,ownedBacking=!!backing&&backing.document===input.document&&backing.revision===input.revision&&
  backing.pageId===input.pageId&&backing.epoch===f?.epoch
 return input.allowed===true&&!!f?.preview&&!f.managed&&!f.grid&&!f.checkerboard&&!f.pixelPreview&&
  f.document===input.document&&f.pageId===input.pageId&&f.width===input.width&&f.height===input.height&&f.pixelRatio===input.dpr&&
  input.items.filter(item=>item.active).every(item=>{
   const tile=item.tile as typeof item.tile&{document?:DesignDocument;revision?:number}
   return tile.document===input.document&&tile.revision===input.revision||ownedBacking&&backing!.residents.get(tile.key)===tile
  })
}
