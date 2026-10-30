import { expect, test } from 'vitest'
import { ResidentGeometry } from './resident-geometry'

test('GPU mirror remains bit-identical through sparse edits, resize, transfer and buffer recreation', () => {
  const mirror=new ResidentGeometry();let device=new Uint32Array(1024)
  const submit=(values:Float32Array)=>{
    const input=new Uint32Array(values.buffer,values.byteOffset,values.length).slice(), update=mirror.update(values)
    if(update)device.set(update.data,update.offset/4)
    expect(device.subarray(0,values.length)).toEqual(input)
    return update?.data.byteLength||0
  }
  const source=Float32Array.from({length:256},(_,i)=>i+.125)
  expect(submit(source)).toBe(1024);expect(submit(source.slice())).toBe(0)
  const edited=source.slice();edited[200]=-.5;expect(submit(edited)).toBe(4)
  expect(submit(edited.subarray(0,64))).toBe(0)
  expect(submit(edited)).toBe(192*4)
  const bits=new Uint32Array(edited.buffer);bits[12]=0x80000000;bits[13]=0x7fc00001
  expect(submit(edited)).toBe(8)
  const transferred=structuredClone(edited,{transfer:[edited.buffer]});expect(submit(transferred)).toBe(0)
  mirror.reset();device=new Uint32Array(1024);expect(submit(transferred)).toBe(1024)
})
