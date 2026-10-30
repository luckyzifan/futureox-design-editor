@group(0) @binding(0) var<uniform> config:ByteTentConfig;
@group(0) @binding(1) var sourceAlpha:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> prefixes:array<vec4<u32>>;
var<workgroup> sums:array<u32,256>;
var<workgroup> moments:array<vec2<u32>,256>;
var<workgroup> carrySum:u32;
var<workgroup> carryMoment:vec2<u32>;
@compute @workgroup_size(256) fn scanByteTent(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 let horizontal=config.settings.y==0u;let length=select(config.dims.y,config.dims.x,horizontal);
 let line=group.x;if(line>=config.settings.w){return;}
 let cross=i32(line+config.settings.z)+select(config.offsets.x,config.offsets.y,horizontal);
 let crossLength=i32(select(config.dims.x,config.dims.y,horizontal));
 if(lane==0u){carrySum=0u;carryMoment=vec2<u32>(0u);}workgroupBarrier();
 for(var block=0u;block<length;block=block+256u){
  let along=block+lane;var alpha=0u;
  if(along<length&&cross>=0&&cross<crossLength){
   let pixel=select(vec2<i32>(cross,i32(along)),vec2<i32>(i32(along),cross),horizontal);
   alpha=u32(round(textureLoad(sourceAlpha,pixel,0).a*255.));
  }
  sums[lane]=alpha;moments[lane]=btMul(alpha,along);workgroupBarrier();
  for(var distance=1u;distance<256u;distance=distance*2u){
   let ownSum=sums[lane];let ownMoment=moments[lane];var previousSum=0u;var previousMoment=vec2<u32>(0u);
   if(lane>=distance){previousSum=sums[lane-distance];previousMoment=moments[lane-distance];}
   workgroupBarrier();sums[lane]=ownSum+previousSum;moments[lane]=btAdd(ownMoment,previousMoment);workgroupBarrier();
  }
  if(along<length){let moment=btAdd(carryMoment,moments[lane]);prefixes[line*length+along]=vec4<u32>(carrySum+sums[lane],0u,moment);}
  workgroupBarrier();
  if(lane==0u){carrySum=carrySum+sums[255];carryMoment=btAdd(carryMoment,moments[255]);}
  workgroupBarrier();
 }
}

