import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { FrameResources } from './frame-resources'
import { decodeScenePacket } from './scene-packet'

test('incremental native poses and camera changes reconstruct the full exact packet', () => {
  const doc = blank(), shape = node('ellipse', 12.25, 8.125, 42, 30)
  shape.fills = [paint('#2255aa')]; doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const kernel = new VectorEngine(), resources = new FrameResources()
  try {
    kernel.load_document(JSON.stringify(doc));kernel.bind_frame_scene_scope('poses')
    const options = { pageId: doc.pages[0].id, width: 128, height: 128, view: { x: .25, y: -.125, zoom: 1.2 }, rasterProfile: 'analytic' }
    const verify = (reset: boolean) => {
      if(reset)resources.clear()
      const settings=JSON.stringify(options),lease=resources.capture()
      const bytes=kernel.compile_gpu_packet(JSON.stringify({...options,frameResources:lease.acknowledgement}))
      let actual
      try{actual=decodeScenePacket(bytes,resources,lease)}finally{lease.release()}
      const full=decodeScenePacket(kernel.compile_gpu_packet(settings))
      expect(actual).toEqual(full)
      return { actual, bytes }
    }
    const first = verify(true), unchanged = verify(false)
    expect(unchanged.bytes.length).toBeLessThan(first.bytes.length)
    expect(unchanged.actual.curves).toEqual(first.actual.curves)
    expect(unchanged.actual.nodes[shape.id]).toBe(first.actual.nodes[shape.id])
    for (const x of [.125, 1.375, -4.875]) {
      expect(kernel.apply_interaction_transforms(JSON.stringify({ [shape.id]: [1, 0, 0, 1, 12.25 + x, 8.125] }))).toBe(true)
      verify(false)
    }
    options.view.zoom = 2.125; verify(false)
    const bytes = kernel.compile_gpu_packet(JSON.stringify(options))
    const broken = bytes.slice(); broken[4] = 9
    expect(() => decodeScenePacket(broken)).toThrow('Unsupported')
    decodeScenePacket(bytes)
    expect(decodeScenePacket(bytes)).toBe(decodeScenePacket(bytes))
    verify(true)
    kernel.load_document(JSON.stringify(blank())); resources.clear()
  } finally { kernel.free() }
})

test('omitted resources require the exact acknowledged producer scope and can resynchronize after reset',()=>{
  const kernel=new VectorEngine(),resources=new FrameResources(),doc=blank()
  try{
    kernel.load_document(JSON.stringify(doc));kernel.bind_frame_scene_scope('base')
    const options={pageId:doc.pages[0].id,width:32,height:32,view:{x:0,y:0,zoom:1}}
    const first=resources.capture()
    try{decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({...options,frameResources:first.acknowledgement})),resources,first)}finally{first.release()}
    const old=resources.capture(),packet=kernel.compile_gpu_packet(JSON.stringify({...options,frameResources:old.acknowledgement}))
    resources.clear();expect(()=>decodeScenePacket(packet.slice())).toThrow('Missing frame resource')
    expect(()=>decodeScenePacket(packet,resources,old)).not.toThrow();old.release()
    expect(resources.bytes).toBe(0)
    const next=resources.capture()
    try{expect(()=>decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({...options,frameResources:next.acknowledgement})),resources,next)).not.toThrow()}finally{next.release()}
  }finally{kernel.free()}
})
