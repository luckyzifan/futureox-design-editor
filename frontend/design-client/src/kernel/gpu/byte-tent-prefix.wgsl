// Unsigned two-limb arithmetic. Every admitted sum/moment fits well below
// 2^64; operations retain the low word and explicit carry/borrow.
fn btAdd(a:vec2<u32>,b:vec2<u32>)->vec2<u32>{let lo=a.x+b.x;return vec2<u32>(lo,a.y+b.y+select(0u,1u,lo<a.x));}
fn btSub(a:vec2<u32>,b:vec2<u32>)->vec2<u32>{return vec2<u32>(a.x-b.x,a.y-b.y-select(0u,1u,a.x<b.x));}
fn btMul(a:u32,b:u32)->vec2<u32>{
 let a0=a&65535u;let a1=a>>16u;let b0=b&65535u;let b1=b>>16u;
 let w0=a0*b0;let t=a1*b0+(w0>>16u);let w1=(t&65535u)+a0*b1;
 return vec2<u32>((w1<<16u)|(w0&65535u),a1*b1+(t>>16u)+(w1>>16u));
}
fn btScale(a:vec2<u32>,b:u32)->vec2<u32>{let p=btMul(a.x,b);return vec2<u32>(p.x,p.y+a.y*b);}
fn btLe(a:vec2<u32>,b:vec2<u32>)->bool{return a.y<b.y||(a.y==b.y&&a.x<=b.x);}
struct ByteTentConfig{dims:vec4<u32>,offsets:vec4<i32>,settings:vec4<u32>}

