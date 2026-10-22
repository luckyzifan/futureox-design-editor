import type { CanvasCamera } from '../../canvas-camera'
import type { Point, Matrix } from '../../model'
import { apply, multiply } from '../../geometry'
import { CanvasLabels, type CanvasLabel } from './canvas-labels'

export type CanvasOverlay = { selection?: { corners: Point[]; handles: boolean; owners?: string[] }; pixelGrid: boolean
  labels?: CanvasLabel[]; measurements?: {from:Point;to:Point}[]; transforms?:Record<string,Matrix> }
const blue = [13 / 255, 153 / 255, 1, 1], white = [1, 1, 1, 1]

export function translateOverlay(overlay: CanvasOverlay, offsets: Map<string, Point>): CanvasOverlay {
  const offset = (owners?: string[]) => owners?.map(id=>offsets.get(id)).find(Boolean) || {x:0,y:0}
  const delta=offset(overlay.selection?.owners)
  return { ...overlay, selection:overlay.selection?{...overlay.selection,corners:overlay.selection.corners.map(p=>({x:p.x+delta.x,y:p.y+delta.y}))}:undefined,
    labels:overlay.labels?.map(label=>{const d=offset(label.owners);return{...label,anchor:{x:label.anchor.x+d.x,y:label.anchor.y+d.y}}}) }
}

/** Apply only chrome geometry to a completed native pose. Document textures
 * are re-rasterized, never warped to imitate affine sample quality. */
export function transformOverlay(overlay: CanvasOverlay, matrices: ReadonlyMap<string, Matrix>): CanvasOverlay {
  const matrix = (owners?: string[]) => owners?.map(id => matrices.get(id)).find(Boolean)
  const selection = matrix(overlay.selection?.owners)
  return { ...overlay, selection: overlay.selection && selection ? { ...overlay.selection,
    corners: overlay.selection.corners.map(point => apply(selection, point)) } : overlay.selection,
    labels: overlay.labels?.map(label => {
      const pose = matrix(label.owners)
      return !pose ? label : { ...label, anchor: apply(pose, label.anchor),
        ...(label.basis ? { basis: multiply(pose, [...label.basis, 0, 0]).slice(0, 4) as [number, number, number, number] } : {}) }
    }) }
}

/** Chrome is projected with the exact camera used to composite document
 * pixels. It never enters the retained document backbuffer or export data. */
export function overlayVertices(overlay: CanvasOverlay, view: CanvasCamera, width: number, height: number) {
  const values: number[] = []
  const quad = (points: Point[], color: number[], edge?: { distance: number; halfWidth: number }) => {
    for (const index of [0, 1, 2, 0, 2, 3]) values.push(points[index].x, points[index].y, ...color,
      edge ? (index < 2 ? edge.distance : -edge.distance) : 0, edge?.halfWidth ?? -1)
  }
  const line = (a: Point, b: Point, stroke: number, color: number[]) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (!length) return
    const distance = stroke / 2 + 1
    const x = (a.y - b.y) / length * distance, y = (b.x - a.x) / length * distance
    quad([{ x: a.x + x, y: a.y + y }, { x: b.x + x, y: b.y + y }, { x: b.x - x, y: b.y - y }, { x: a.x - x, y: a.y - y }], color, { distance, halfWidth: stroke / 2 })
  }
  if (overlay.pixelGrid && view.zoom >= 4) {
    const color = [91 / 255 * .16, 88 / 255 * .16, 114 / 255 * .16, .16]
    for (let x = view.x - Math.floor(view.x / view.zoom) * view.zoom; x <= width; x += view.zoom)
      line({ x, y: 0 }, { x, y: height }, 1, color)
    for (let y = view.y - Math.floor(view.y / view.zoom) * view.zoom; y <= height; y += view.zoom)
      line({ x: 0, y }, { x: width, y }, 1, color)
  }
  if (overlay.selection) {
    const points = overlay.selection.corners.map(p => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y }))
    for (let i = 0; i < points.length; i++) line(points[i], points[(i + 1) % points.length], 1.3, blue)
    if (overlay.selection.handles) for (let i = 0; i < points.length; i++) {
      const point = points[i], next = points[(i + 1) % points.length], previous = points[(i + points.length - 1) % points.length]
      const unit = (p: Point) => { const length = Math.hypot(p.x-point.x,p.y-point.y); return length > 1e-10 ? {x:(p.x-point.x)/length,y:(p.y-point.y)/length} : undefined }
      const u = unit(next) || {x:1,y:0}, v = unit(previous) || {x:-u.y,y:u.x}
      const square = (r: number) => [[-r,-r],[r,-r],[r,r],[-r,r]].map(([x,y]) => ({
        x: point.x + u.x * x + v.x * y,
        y: point.y + u.y * x + v.y * y }))
      quad(square(4.5), blue); quad(square(3.5), white)
    }
  }
  for(const measurement of overlay.measurements||[]) line(
    {x:measurement.from.x*view.zoom+view.x,y:measurement.from.y*view.zoom+view.y},
    {x:measurement.to.x*view.zoom+view.x,y:measurement.to.y*view.zoom+view.y},1,[242/255,72/255,34/255,1])
  return new Float32Array(values)
}

export class CanvasOverlayRenderer {
  private labels?: CanvasLabels
  private pipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private vertices: GPUBuffer
  private bind: GPUBindGroup
  constructor(private device: GPUDevice, private format: GPUTextureFormat) {
    const module = device.createShaderModule({ code: `struct U { size: vec2<f32> }
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>, @location(1) edge: vec2<f32> }
@vertex fn vertex(@location(0) p: vec2<f32>, @location(1) color: vec4<f32>, @location(2) edge: vec2<f32>) -> V {
 return V(vec4(p.x/u.size.x*2.-1., 1.-p.y/u.size.y*2., 0., 1.), color, edge);
}
@fragment fn fragment(v: V) -> @location(0) vec4<f32> {
 let coverage = clamp((v.edge.y-abs(v.edge.x))/max(fwidth(v.edge.x), 0.00001)+0.5, 0., 1.);
 return v.color * select(coverage, 1., v.edge.y < 0.);
}` })
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.vertices = device.createBuffer({ size: 65536 * 32, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.pipeline = device.createRenderPipeline({ layout: 'auto',
      vertex: { module, entryPoint: 'vertex', buffers: [{ arrayStride: 32, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x4' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' }] }] },
      fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list' } })
    this.bind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }] })
  }
  draw(encoder: GPUCommandEncoder, target: GPUTexture, overlay: CanvasOverlay, view: CanvasCamera, width: number, height: number, dpr: number) {
    const vertices = overlayVertices(overlay, view, width, height)
    if (vertices.length) {
    if (vertices.byteLength > this.vertices.size) throw Error('Canvas overlay geometry budget exceeded')
    this.device.queue.writeBuffer(this.vertices, 0, vertices as Float32Array<ArrayBuffer>)
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([width, height, 0, 0]))
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }] })
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind); pass.setVertexBuffer(0, this.vertices)
    pass.draw(vertices.length / 8); pass.end()
    }
    if (overlay.labels?.length) { this.labels ??= new CanvasLabels(this.device,this.format); this.labels.draw(encoder,target,overlay.labels,view,width,height,dpr) }
  }
  dispose() { this.uniform.destroy(); this.vertices.destroy(); this.labels?.dispose() }
  get residentBytes(){return this.uniform.size+this.vertices.size+(this.labels?.residentBytes||0)}
}
