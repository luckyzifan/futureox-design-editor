import type { LinearImageRows } from '../image-row-source'
import {certifyExactImageRange,createExactImageRangeAccumulator} from './exact-image-x-table'
/** Validate a complete monotone upload. Caller owns and destroys an unpublished
 * target on any decoder/write/length failure. No partial resource is reusable. */
export function validateLinearImageDimensions(width:number,height:number){
  if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||width*height>16_777_216)throw Error('Invalid PNG row upload dimensions')
}
export function writeLinearImageRows(width:number,height:number,rows:LinearImageRows,
  write:(y:number,height:number,pixels:Float32Array)=>void,collectRange=false){
  validateLinearImageDimensions(width,height)
  const range=collectRange?createExactImageRangeAccumulator():undefined
  let y=0
  for(const row of rows){
    if(row.y!==y||!Number.isSafeInteger(row.height)||row.height<1||y+row.height>height||
      !(row.pixels instanceof Float32Array)||!(row.pixels.buffer instanceof ArrayBuffer)||
      row.pixels.length!==width*row.height*4||row.pixels.byteLength>4*1024*1024)throw Error('Invalid PNG row upload range')
    if(range){const piece=certifyExactImageRange(row.pixels);if(!piece)throw Error('Invalid PNG row upload pixel');range.add(piece)}
    else for(const value of row.pixels)if(!Number.isFinite(value))throw Error('Invalid PNG row upload pixel')
    write(y,row.height,row.pixels);y+=row.height
  }
  if(y!==height)throw Error('Incomplete PNG row upload')
  return range?.finish(width*height)
}
