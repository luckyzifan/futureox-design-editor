/** Numeric readback probe: every valid byte gray/alpha pair, no reference PNG
 * in the browser. Recovered display GLSL uses rgb/max(alpha, .00001). */
import {chromium} from '@playwright/test'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const output=await mkdtemp(join(tmpdir(),'fd-alpha-shader-'))
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<!doctype html><canvas width="256" height="256"></canvas>',{headers:{'content-type':'text/html'}})})
const browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--use-angle=metal']})
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.port}`)
 const result=await page.evaluate(()=>{
  const gl=document.querySelector('canvas')!.getContext('webgl2',{premultipliedAlpha:false,antialias:false})!
  if(!gl)throw Error('WebGL2 unavailable')
  const info=gl.getExtension('WEBGL_debug_renderer_info'),renderer=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):''
  if(!/Metal|Apple/.test(renderer)||/SwiftShader|software/i.test(renderer))throw Error('Hardware Metal required: '+renderer)
  const compile=(type:number,source:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s)||'Compile');return s}
  const program=gl.createProgram()!
  gl.attachShader(program,compile(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'))
  gl.attachShader(program,compile(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;uniform sampler2D source;out vec4 color;void main(){vec4 p=texelFetch(source,ivec2(gl_FragCoord.xy),0);color=vec4(p.rgb/max(p.a,0.00001),p.a);}'))
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program)||'Link');gl.useProgram(program)
  const input=new Uint8Array(256*256*4)
  for(let a=0;a<256;a++)for(let c=0;c<256;c++){const i=(a*256+c)*4;input.set([Math.min(c,a),Math.min(c,a),Math.min(c,a),a],i)}
  const texture=(bytes:Uint8Array|null)=>{const t=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,256,256,0,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return t}
  const src=texture(input),dst=texture(null),fbo=gl.createFramebuffer()!;gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,dst,0)
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Framebuffer incomplete')
  gl.bindTexture(gl.TEXTURE_2D,src);gl.uniform1i(gl.getUniformLocation(program,'source'),0);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.viewport(0,0,256,256);gl.drawArrays(gl.TRIANGLES,0,3)
  const rgba=new Uint8Array(input.length);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,rgba);if(gl.getError()!==gl.NO_ERROR)throw Error('Readback failed')
  if(!gl.getExtension('EXT_color_buffer_float'))throw Error('Float diagnostic target unavailable')
  const floats=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,floats);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,256,256,0,gl.RGBA,gl.FLOAT,null);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,floats,0)
  const fp=gl.createProgram()!;gl.attachShader(fp,compile(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'))
  gl.attachShader(fp,compile(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;uniform sampler2D source;out vec4 color;void main(){vec4 p=texelFetch(source,ivec2(gl_FragCoord.xy),0);float a=max(p.a,0.00001);color=vec4(p.r,p.a,1.0/a,p.r/a);}'));gl.linkProgram(fp);if(!gl.getProgramParameter(fp,gl.LINK_STATUS))throw Error('Float link');gl.useProgram(fp);gl.bindTexture(gl.TEXTURE_2D,src);gl.uniform1i(gl.getUniformLocation(fp,'source'),0);gl.drawArrays(gl.TRIANGLES,0,3)
  const numeric=new Float32Array(input.length);gl.readPixels(0,0,256,256,gl.RGBA,gl.FLOAT,numeric);if(gl.getError()!==gl.NO_ERROR)throw Error('Float readback failed')
  return {rgba:[...rgba],numeric:[...new Uint8Array(numeric.buffer)],renderer}
 })
 await writeFile(join(output,'conversion.rgba'),Buffer.from(result.rgba));await writeFile(join(output,'numeric.f32'),Buffer.from(result.numeric));await writeFile(join(output,'provenance.json'),JSON.stringify({scope:'All valid 8-bit premultiplied gray/alpha pairs via independent GLSL shader to RGBA8/F32 FBO; no PNG encoding',browser:browser.version(),renderer:result.renderer},null,2));console.log(JSON.stringify({status:'captured',output}))
}finally{await browser.close();server.stop(true)}
