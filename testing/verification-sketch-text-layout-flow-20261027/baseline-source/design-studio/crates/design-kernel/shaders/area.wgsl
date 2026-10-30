// Interval-program interface. cvFetch reads a vec4 relative to the program
// start; the embedding backend supplies the storage-buffer / texture adapter.
fn cvBits(v:vec4<f32>)->vec2<u32>{let a:vec4<u32>=vec4<u32>(v);return vec2<u32>(a.x|(a.y<<16u),a.z|(a.w<<16u));}
fn cvAxis(pixel:i32,range:vec4<f32>,left:vec2<u32>,right:vec2<u32>)->vec3<u32>{
 let lo:i32=i32(range.x);let hi:i32=i32(range.y);
 if(pixel<lo||pixel>hi){return vec3<u32>(0);}
 if(pixel==lo&&pixel==hi){return cvWidth(u32(range.w-range.z),right,left);}
 if(pixel==lo){return cvWidth(u32(1.-range.z),vec2<u32>(0),left);}
 if(pixel==hi){return cvWidth(u32(range.w),right,vec2<u32>(0));}
 return vec3<u32>(0u,0x100000u,52u);
}
// Exact binary64 ordering at the fixed eighth-pixel sample locations.
fn sampleBits(offset:f32,upper:f32)->vec2<u32>{
 let bits:u32=bitcast<u32>(offset-upper);let mantissa:u32=bits&0x7fffffu;
 return vec2<u32>(mantissa<<29u,(bits&0x80000000u)|((((bits>>23u)&255u)+896u)<<20u)|(mantissa>>3u));
}
fn compare64(a:vec2<u32>,b:vec2<u32>)->i32{
 if(a.x==b.x&&a.y==b.y){return 0;}
 let negative:bool=(a.y>>31u)!=0u;let otherNegative:bool=(b.y>>31u)!=0u;
 if(negative!=otherNegative){if(negative){return -1;}return 1;}
 var less:bool=a.y<b.y||(a.y==b.y&&a.x<b.x);
 if(negative){less=!less;}if(less){return -1;}return 1;
}
fn sampleInside(pixel:i32,offset:f32,range:vec4<f32>,left:vec2<u32>,right:vec2<u32>)->bool{
 let lo:i32=i32(range.x);let hi:i32=i32(range.y);
 if(pixel<lo||pixel>hi){return false;}
 if(pixel==lo&&compare64(sampleBits(offset,range.z),left)<0){return false;}
 if(pixel==hi&&compare64(sampleBits(offset,range.w),right)>=0){return false;}
 return true;
}
fn sampleOffset(index:u32)->vec2<f32>{
 if(index==0u){return vec2<f32>(0.375,0.125);}if(index==1u){return vec2<f32>(0.875,0.375);}
 if(index==2u){return vec2<f32>(0.125,0.625);}return vec2<f32>(0.625,0.875);
}
// Scanline intervals are ordered and disjoint. Locate the first interval
// whose integer right bound can touch this pixel; endpoint bits and the
// original accumulation order remain unchanged. Small rows avoid the search.
fn firstSpan(pixel:i32,first:u32,count:u32)->u32{
 if(count<16u){return 0u;}
 var lo:u32=0u;var hi:u32=count;
 while(lo<hi){let mid:u32=lo+(hi-lo)/2u;
  if(i32(cvFetch(first+mid*3u).y)<pixel){lo=mid+1u;}else{hi=mid;}
 }
 return lo;
}
fn sampleCoverage(pixel:vec2<i32>,index:u32)->f32{
 let header:vec4<f32>=cvFetch(0u);let offset:vec2<f32>=sampleOffset(index);
 if(header.x==4.){
  if(sampleInside(pixel.x,offset.x,cvFetch(1u),cvBits(cvFetch(3u)),cvBits(cvFetch(4u)))&&sampleInside(pixel.y,offset.y,cvFetch(2u),cvBits(cvFetch(5u)),cvBits(cvFetch(6u)))){return 1.;}return 0.;
 }
 let record:vec4<f32>=cvFetch(u32(header.y)+u32(pixel.y)*4u+index);
 for(var span:u32=firstSpan(pixel.x,u32(record.x),u32(record.y));span<u32(record.y);span=span+1u){
  let at:u32=u32(record.x)+span*3u;let range:vec4<f32>=cvFetch(at);
  if(pixel.x<i32(range.x)){break;}
  if(pixel.x>i32(range.y)){continue;}
  if(sampleInside(pixel.x,offset.x,range,cvBits(cvFetch(at+1u)),cvBits(cvFetch(at+2u)))){return 1.;}
 }
 return 0.;
}
fn areaCoverage(pixel:vec2<i32>)->f32{
 let header:vec4<f32>=cvFetch(0u);
 if(header.x==2.){return 0.;}
 if(header.x==3.||header.x==4.){
  let selected:i32=cvSampleIndex();if(selected>0){return sampleCoverage(pixel,u32(selected-1));}
  var sum:f32=0.;for(var i:u32=0u;i<4u;i=i+1u){sum=sum+sampleCoverage(pixel,i);}
  return sum*0.25;
 }
 if(header.x==1.){
  let x:vec3<u32>=cvAxis(pixel.x,cvFetch(1u),cvBits(cvFetch(3u)),cvBits(cvFetch(4u)));
  let y:vec3<u32>=cvAxis(pixel.y,cvFetch(2u),cvBits(cvFetch(5u)),cvBits(cvFetch(6u)));
  return cvProduct(x,y);
 }
 var sum:f32=0.;
 for(var row:u32=0u;row<8u;row=row+1u){
  let record:vec4<f32>=cvFetch(u32(header.y)+u32(pixel.y)*8u+row);
  let first:u32=u32(record.x);let count:u32=u32(record.y);
  for(var span:u32=firstSpan(pixel.x,first,count);span<count;span=span+1u){
   let index:u32=first+span*3u;let range:vec4<f32>=cvFetch(index);
   if(pixel.x<i32(range.x)){break;}
   if(pixel.x>i32(range.y)){continue;}
   let width:vec3<u32>=cvAxis(pixel.x,range,cvBits(cvFetch(index+1u)),cvBits(cvFetch(index+2u)));
   sum=addRN(sum,cvScaled(width.xy,width.z+3u));
  }
 }
 return clamp(sum,0.,1.);
}
