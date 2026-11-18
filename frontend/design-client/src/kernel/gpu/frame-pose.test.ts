import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { FrameResources } from './frame-resources'
import { CompiledScenePacket, copyScenePacket, decodeScenePacket } from './scene-packet'

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

test('an affine pose reuses acknowledged curve programs and reconstructs their exact relocation', () => {
  const kernel = new VectorEngine(), resources = new FrameResources()
  const doc = blank(), page = doc.pages[0]
  const moving = node('ellipse', 12, 18, 46, 25)
  for (const shape of [moving, ...Array.from({ length: 8 }, (_, i) =>
    node('ellipse', 70 + i * 8, 12 + i * 7, 34 - i, 37 + i))]) {
    shape.fills = [paint('#2244bb')]
    doc.nodes[shape.id] = shape
    page.children.push(shape.id)
  }
  const options = { pageId: page.id, width: 160, height: 128, rasterProfile: 'analytic',
    view: { x: .125, y: .375, zoom: 1 } }
  try {
    kernel.load_document(JSON.stringify(doc))
    kernel.bind_frame_scene_scope('curve-pose')
    const request = () => {
      const lease = resources.capture()
      try {
        const packet = kernel.compile_gpu_packet(JSON.stringify({
          ...options, frameResources: { ...lease.acknowledgement, curvePrograms: true },
        }))
        return { packet, actual: decodeScenePacket(packet, resources, lease) }
      } finally { lease.release() }
    }
    request()
    const transform = [.8, .6, -.6, .8, 16, 13]
    expect(kernel.apply_interaction_transforms(JSON.stringify({ [moving.id]: transform }))).toBe(true)
    const {packet, actual} = request()
    const raw = kernel.compile_gpu_packet(JSON.stringify(options))
    const exact = decodeScenePacket(raw)
    expect(exact.curves?.length).toBeGreaterThan(0)
    expect(new DataView(packet.buffer, packet.byteOffset).getUint32(16, true)).toBe(0)
    expect(actual).toEqual(exact)
    expect(packet.byteLength).toBeLessThan(raw.byteLength / 2)
    expect(decodeScenePacket(copyScenePacket(packet))).toEqual(exact)
    expect(CompiledScenePacket.from(packet, true).scene).toEqual(exact)
    const missing = packet.slice()
    expect(() => decodeScenePacket(missing)).toThrow('Missing frame resource')
    resources.clear()
    expect(request().actual).toEqual(exact)
  } finally { kernel.free() }
})
