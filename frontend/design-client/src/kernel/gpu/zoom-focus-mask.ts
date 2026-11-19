export const ZOOM_UNIFORM_LEAF = 8
export const ZOOM_UNIFORM_BLOCK = 64
export const ZOOM_MASK_SUMMARY_MODE = 91
export const ZOOM_MASK_COMPOSITE_MODE = 92

export const zoomFocusMaskWgsl = `
const leaf: i32 = ${ZOOM_UNIFORM_LEAF};
const blockSide: i32 = ${ZOOM_UNIFORM_BLOCK};
const magnitudes: vec4<u32> = vec4<u32>(0x7fffffffu);

// The canvas reducer reads 64 entries. Native 100-entry table rows can be
// crossed once; bound both monotone segments and their bilinear neighbours.
fn zoomTapInterval(index: u32, base: u32, stride: u32) -> vec2<i32> {
  let first = i32(motionKernelTap(base + index).x);
  let last = i32(motionKernelTap(base + index + 63u).x);
  var lo = min(first, last);
  var hi = max(first, last);
  let next = stride - index % stride;
  if next < 64u {
    let before = i32(motionKernelTap(base + index + next - 1u).x);
    let after = i32(motionKernelTap(base + index + next).x);
    lo = min(lo, min(before, after));
    hi = max(hi, max(before, after));
  }
  return vec2<i32>(lo, hi + 1);
}

fn zoomCanonicalZero(value:vec4<f32>) -> vec4<f32> {
  let bits = bitcast<vec4<u32>>(value);
  return bitcast<vec4<f32>>(select(bits, vec4<u32>(0u), (bits & magnitudes) == vec4<u32>(0u)));
}

fn zoomMask(point: vec2<i32>) -> f32 {
  return coverage_at_A(u(1).xy + vec2<f32>(point) + 0.5, u(13)).a;
}

@fragment fn summarizeZoomMask(@builtin(position) position:vec4<f32>) -> @location(0) vec4<f32> {
  let coarse = u(9).x > 0.;
  let start = vec2<i32>(position.xy) * leaf;
  let size = vec2<i32>(u(1).zw);
  let limit = min(start + vec2<i32>(leaf), select(size, (size+leaf-1)/leaf, coarse));
  let sample = zoomMask(select(start, start*leaf, coarse));
  for (var row = start.y; row < limit.y; row += 1) {
    for (var col = start.x; col < limit.x; col += 1) {
      let point = vec2<i32>(col,row);
      if coarse {
        let cell = textureLoad(sourceB,point,0);
        if cell.x != 1. || cell.y != sample { return vec4<f32>(0.); }
      } else if zoomMask(point) != sample { return vec4<f32>(0.); }
    }
  }
  return vec4<f32>(1.,sample,0.,0.);
}

fn constantMaskOnRay(pixel:vec2<u32>, header:vec4<f32>) -> f32 {
  let stride = u32(header.x);
  let x = zoomTapInterval(pixel.x*64u,1u,stride);
  let y = zoomTapInterval(pixel.y*64u,u32(header.w),stride);
  let lo = vec2<i32>(x.x,y.x);
  let hi = vec2<i32>(x.y,y.y);
  let size = vec2<i32>(u(1).zw);
  if any(hi<vec2<i32>(0)) || any(lo>=size) { return 0.; }
  let first = max(lo,vec2<i32>(0))/blockSide;
  let last = min(hi,size-vec2<i32>(1))/blockSide;
  let extent = last-first+vec2<i32>(1);
  if extent.x*extent.y>16 { return -1.; }
  let sample = textureLoad(sourceC,first,0).y;
  if sample != 0. && (any(lo<vec2<i32>(0)) || any(hi>=size)) { return -1.; }
  for(var row=first.y;row<=last.y;row+=1){
    for(var col=first.x;col<=last.x;col+=1){
      let cell=textureLoad(sourceC,vec2<i32>(col,row),0);
      if cell.x!=1. || cell.y!=sample { return -1.; }
    }
  }
  return sample;
}

fn zoomMaskAt(p:vec2<f32>) -> f32 {
  let header=motionKernelTap(0u);
  if header.x!=64. && header.x!=100. { return coverage_at_A(p,u(13)).a; }
  let pixel=vec2<u32>(floor(p-u(1).xy));
  let constant=constantMaskOnRay(pixel,header);
  if constant>=0. { return constant; }
  var sum=0.;
  var correction=0.;
  for(var i=0u;i<64u;i+=1u){
    let x=motionKernelTap(1u+pixel.x*64u+i);
    let y=motionKernelTap(u32(header.w)+pixel.y*64u+i);
    let q=vec2<i32>(i32(x.x),i32(y.x));
    let sample=mix(mix(zoomMask(q),zoomMask(q+vec2<i32>(1,0)),x.y),
      mix(zoomMask(q+vec2<i32>(0,1)),zoomMask(q+vec2<i32>(1,1)),x.y),y.y);
    let value=sample-correction;
    let next=sum+value;
    correction=(next-sum)-value;
    sum=next;
  }
  return clamp(sum/64.,0.,1.);
}

@fragment fn canvasZoomMaskComposite(@builtin(position) position:vec4<f32>) -> @location(0) vec4<f32> {
  let p=position.xy+u(0).xy;
  let back=zoomCanonicalZero(at(sourceD,p,u(11)));
  if any(p<u(1).xy) || any(p>=u(1).xy+u(1).zw) { return back; }
  let alpha=zoomMaskAt(p);
  if alpha<=0. { return back; }
  // Only opaque unit solid paints reach this shader. The same linear SDR
  // reducer can operate on coverage, with premultiplication once at the end.
  let front=mulRN4(u(12),vec4<f32>(alpha));
  if back.a<=0. { return front; }
  return addRN4(front,mulRN4(back,vec4<f32>(addRN(1.,-alpha))));
}
`
