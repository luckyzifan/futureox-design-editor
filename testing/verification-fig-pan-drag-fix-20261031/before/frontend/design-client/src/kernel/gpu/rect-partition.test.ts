import {expect,test} from 'vitest'
import {rectangleBorder} from './rect-partition'
import {intersect} from './types'
test('border pieces cover each pixel once for clipped, empty and complete interiors',()=>{
  const r={x:-7,y:11,w:23,h:19}
  for(const inset of [-4,0,1,3,9,19]){
    const i=intersect(r,{x:r.x+inset,y:r.y+inset,w:Math.max(0,r.w-2*inset),h:Math.max(0,r.h-2*inset)})
    const pieces=[...rectangleBorder(r,i),i].filter(p=>p.w&&p.h)
    for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)
      expect(pieces.filter(p=>x>=p.x&&y>=p.y&&x<p.x+p.w&&y<p.y+p.h)).toHaveLength(1)
  }
})
