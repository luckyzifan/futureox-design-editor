import type { Rect } from './types'

/** Native compiler metadata, never an inferred visibility hint. Strict bounds
 * retain every certified suffix pixel; invalid metadata fails before copying. */
export function painterStageBox(value: readonly number[], extent: Rect): Rect {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isSafeInteger))
    throw Error('Invalid native painter stage box')
  const [x,y,w,h]=value
  if(w<1||h<1||w>16384||h>16384||[x,y,x+w,y+h].some(v=>Math.abs(v)>1048576)||
      x<extent.x||y<extent.y||x+w>extent.x+extent.w||y+h>extent.y+extent.h)
    throw Error('Invalid native painter stage bounds')
  return{x,y,w,h}
}
