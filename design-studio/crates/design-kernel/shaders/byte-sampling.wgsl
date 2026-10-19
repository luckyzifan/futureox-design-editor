// Byte-surface program: managed sampling is unreachable. Keep this program
// small so SDR pipelines do not compile or reserve the HDR integer accumulator.
fn bsBilinear4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>,k:vec2<f32>,wordLimit:u32,termCount:u32)->vec4<f32>{return mix(mix(a,b,k.x),mix(c,d,k.x),k.y);}

fn bsBilinearChannelAlpha(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>,k:vec2<f32>,channel:u32,wordLimit:u32,termCount:u32)->vec2<f32>{let value=bsBilinear4(a,b,c,d,k,wordLimit,termCount);return vec2<f32>(value[channel],value.w);}
