import {intersect,type Rect} from './types'

/** Four disjoint border rectangles plus the interior exactly partition r. */
export function rectangleBorder(r:Rect, interior:Rect):Rect[] {
  const i=intersect(r,interior)
  if(!i.w||!i.h)return [r]
  return [
    {x:r.x,y:r.y,w:r.w,h:i.y-r.y},
    {x:r.x,y:i.y+i.h,w:r.w,h:r.y+r.h-i.y-i.h},
    {x:r.x,y:i.y,w:i.x-r.x,h:i.h},
    {x:i.x+i.w,y:i.y,w:r.x+r.w-i.x-i.w,h:i.h},
  ].filter(r=>r.w>0&&r.h>0)
}
