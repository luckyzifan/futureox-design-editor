from pathlib import Path
p=Path('design-studio/crates/design-kernel/shaders/vector.wgsl');s=p.read_text();at=s.index('fn shade(p:vec2<f32>)');s=s[:at]+'''fn zoomSample(p:vec2<f32>,tap:u32)->vec4<f32>{
 let header=motionKernelTap(0u);let pixel=vec2<u32>(floor(p-u(1).xy));
 let x=motionKernelTap(1u+pixel.x*64u+tap);let y=motionKernelTap(u32(header.w)+pixel.y*64u+tap);
 let q=u(1).xy+vec2<f32>(x.x,y.x)+0.5;
 return bsBilinear4(at(sourceA,q,u(1)),at(sourceA,q+vec2<f32>(1,0),u(1)),at(sourceA,q+vec2<f32>(0,1),u(1)),at(sourceA,q+vec2<f32>(1,1),u(1)),vec2<f32>(x.y,y.y),19u,9u);
}
fn zoomBlurPixel(p:vec2<f32>)->vec4<f32>{
 var groups:array<vec4<f32>,4>;
 for(var g=0u;g<4u;g=g+1u){var quads:array<vec4<f32>,4>;
  for(var q=0u;q<4u;q=q+1u){let t=g*16u+q*4u;quads[q]=meanFourRN(zoomSample(p,t),zoomSample(p,t+1u),zoomSample(p,t+2u),zoomSample(p,t+3u));}
  groups[g]=meanFourRN(quads[0],quads[1],quads[2],quads[3]);
 }
 return meanFourRN(groups[0],groups[1],groups[2],groups[3]);
}
'''+s[at:];s=s.replace('if(mode==61){return motionBlurPixel(p);}','if(mode==61){return motionBlurPixel(p);}if(mode==62){return zoomBlurPixel(p);}');p.write_text(s)
p=Path('frontend/design-client/src/kernel/gpu/vector.glsl');s=p.read_text();at=s.index('vec4 shade(vec2 p)');s=s[:at]+'''vec4 zoomSample(vec2 p,uint tap){
 vec4 header=motionKernelTap(0u);uvec2 pixel=uvec2(floor(p-u[1].xy));
 vec4 x=motionKernelTap(1u+pixel.x*64u+tap),y=motionKernelTap(uint(header.w)+pixel.y*64u+tap);
 vec2 q=u[1].xy+vec2(x.x,y.x)+.5;
 return bsBilinear4(at(sourceA,q,u[1]),at(sourceA,q+vec2(1,0),u[1]),at(sourceA,q+vec2(0,1),u[1]),at(sourceA,q+vec2(1,1),u[1]),vec2(x.y,y.y),19u,9u);
}
vec4 zoomBlurPixel(vec2 p){
 vec4 groups[4];for(uint g=0u;g<4u;g++){vec4 quads[4];
  for(uint q=0u;q<4u;q++){uint t=g*16u+q*4u;quads[q]=meanFourRN(zoomSample(p,t),zoomSample(p,t+1u),zoomSample(p,t+2u),zoomSample(p,t+3u));}
  groups[g]=meanFourRN(quads[0],quads[1],quads[2],quads[3]);
 }return meanFourRN(groups[0],groups[1],groups[2],groups[3]);
}
'''+s[at:];s=s.replace('if(mode==61)return motionBlurPixel(p);','if(mode==61)return motionBlurPixel(p);if(mode==62)return zoomBlurPixel(p);');p.write_text(s)
for name in ['webgpu.ts','webgl.ts']:
 p=Path('frontend/design-client/src/kernel/gpu')/name;s=p.read_text().replace('mode => mode === 61','mode => mode === 61 || mode === 62').replace('mode === 61 && this.exactMotionSource','(mode === 61 || mode === 62) && this.exactMotionSource').replace('this.managed || u[16] === 61','this.managed || u[16] === 61 || u[16] === 62');p.write_text(s)
p=Path('frontend/design-client/src/kernel/gpu/renderer.ts');s=p.read_text().replace('  motion_blur_kernel,','  motion_blur_kernel,\n  zoom_blur_coordinates,');s=s.replace("fx.kind === 'gaussian-blur' || fx.kind === 'motion-blur'","fx.kind === 'gaussian-blur' || fx.kind === 'motion-blur' || fx.kind === 'zoom-blur'");s=s.replace('''    if (fx.radius === 0) return input''','''    if(fx.zoomBlur){
      if(fx.zoomBlur.amount===0)return input
      const kernel=this.filterKernel(`zoom:${JSON.stringify([input.rect,n.matrix,n.size,fx.zoomBlur.center])}`,fx.zoomBlur.amount,
        ()=>zoom_blur_coordinates(JSON.stringify(fx.zoomBlur),new Float64Array(n.matrix),new Float64Array(n.size),JSON.stringify(input.rect)),values=>[256,values.length/1024])
      const pending=this.admitSurface(input.rect,1,false,false,[input,kernel],()=>this.run(62,input.rect,[input,kernel]))
      return pending?await pending:this.run(62,input.rect,[input,kernel])
    }
    if (fx.radius === 0) return input''',1);p.write_text(s)
p=Path('frontend/design-client/src/kernel/gpu/compositor-modes.ts');s=p.read_text().replace("if (effect.kind === 'motion-blur') modes.add(61)","if (effect.kind === 'motion-blur') modes.add(61)\n      if (effect.kind === 'zoom-blur') modes.add(62)");p.write_text(s)
p=Path('frontend/design-client/src/kernel/render-dependency.ts');s=p.read_text().replace("'motion-blur'","'motion-blur', 'zoom-blur'");p.write_text(s)
