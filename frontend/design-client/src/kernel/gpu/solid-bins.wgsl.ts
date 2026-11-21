import { areaCoverageWgsl } from './area-shader'

const records = /* wgsl */ `
struct Params { values:array<vec4<f32>,64> }
struct Solid {
  bounds:vec4<i32>,
  mask:vec4<i32>,
  paint:vec4<u32>,
}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> records:array<Solid>;
`

// Each bin represents the original order as a pair of 32-bit masks. One
// invocation owns each bin, so insertion order never depends on atomics.
export const solidBinningWgsl = records + /* wgsl */ `
@group(0) @binding(2) var<storage,read_write> bins:array<vec2<u32>>;
@compute @workgroup_size(8,8) fn bin(@builtin(global_invocation_id) index:vec3<u32>) {
  if(any(index.xy>=vec2<u32>(params.values[9].zw))) { return; }
  let lo=vec2<i32>(params.values[0].xy)+vec2<i32>(index.xy)*16;
  let hi=lo+vec2<i32>(16);
  let start=u32(params.values[9].x);
  var mask=vec2<u32>(0u);
  for(var i=0u;i<u32(params.values[9].y);i++) {
    let bounds=records[start+i].bounds;
    if(all(bounds.xy<hi)&&all(bounds.zw>lo)) {
      mask[i/32u] |= 1u<<(i%32u);
    }
  }
  bins[index.y*u32(params.values[9].z)+index.x]=mask;
}
`

export const solidBinShadeWgsl = areaCoverageWgsl + records + /* wgsl */ `
@group(0) @binding(2) var<storage,read> bins:array<vec2<u32>>;
@group(0) @binding(3) var<storage,read> curves:array<vec4<f32>>;
@group(0) @binding(4) var base:texture_2d<f32>;
var<private> programFirst:u32;
fn cvFetch(i:u32)->vec4<f32> { return curves[programFirst+i]; }
fn cvSampleIndex()->i32 { return 0; }
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
  return vec4<f32>(f32((i<<1u)&2u)*2.-1.,1.-f32(i&2u)*2.,0.,1.);
}
fn canonicalZero(v:vec4<f32>)->vec4<f32> {
  let bits=bitcast<vec4<u32>>(v);
  return bitcast<vec4<f32>>(select(bits,vec4<u32>(0u),(bits&vec4<u32>(0x7fffffffu))==vec4<u32>(0u)));
}
fn paint(index:u32,p:vec2<i32>,dst:vec4<f32>)->vec4<f32> {
  let item=records[index];
  if(any(p<item.bounds.xy)||any(p>=item.bounds.zw)) { return dst; }
  programFirst=item.paint.w;
  let coverage=areaCoverage(p-item.mask.xy);
  if(coverage<=0.) { return dst; }
  let src=canonicalZero(mulRN4(vec4<f32>(bitcast<vec3<f32>>(item.paint.xyz),1.),vec4<f32>(coverage)));
  if(dst.a<=0.) { return src; }
  return addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))));
}
@fragment fn fragment(@builtin(position) pos:vec4<f32>)->@location(0) vec4<f32> {
  let local=vec2<i32>(floor(pos.xy));
  let p=local+vec2<i32>(params.values[0].xy);
  let bin=vec2<u32>(local)/16u;
  let membership=bins[bin.y*u32(params.values[9].z)+bin.x];
  var dst=canonicalZero(textureLoad(base,min(local,vec2<i32>(textureDimensions(base))-1),0));
  let start=u32(params.values[9].x);
  for(var word=0u;word<2u;word++) {
    var remaining=membership[word];
    while(remaining!=0u) {
      let bit=firstTrailingBit(remaining);
      dst=paint(start+word*32u+bit,p,dst);
      remaining &= remaining-1u;
    }
  }
  return dst;
}
`
