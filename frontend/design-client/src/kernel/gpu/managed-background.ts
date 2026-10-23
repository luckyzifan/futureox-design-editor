/** Experimental mode12 entry only. The ordinary source/entry is unchanged
 * unless the managed exact driver explicitly opts in. No display-math route. */
export function managedBackgroundEntryPoint(managed: boolean, displayMath: boolean, flag?: string) {
  return managed && !displayMath && flag === '1' ? 'managedBackgroundFragment' : 'fragment'
}

/** Literal source slice of vector.wgsl mode12, not a new arithmetic algorithm.
 * Keep the mode select, predispatch sourceA sample, normal-over early-outs,
 * background/checker/grid order and complete fragment display/quantize wrapper.
 * The only replacements are function names and over(bg,grid,0)'s normal helper.
 * COMPOSITOR_MODE stays a reachable specialization input; the host supplies12.
 * Shared sampling, RN operations and displayColor remain the original module's.
 * See managed-background.test.ts for source-slice drift checks (not pixel proof).
 */
export const managedBackgroundWgsl = `
fn managedBackgroundOverNormal(b:vec4<f32>,s:vec4<f32>)->vec4<f32>{if(s.a<=0.){return b;}if(b.a<=0.){return s;}if(u(60).x>0.5){return addRN4(s,mulRN4(b,vec4<f32>(addRN(1.,-s.a))));}return s+b*(1.-s.a);}
fn managedBackgroundShade(p:vec2<f32>)->vec4<f32>{let mode=select(i32(u(4).x),COMPOSITOR_MODE,COMPOSITOR_MODE>=0);let a=smp(sourceA,p,u(1));
 if(mode==12){var bg=vec4<f32>(u(12).rgb*u(12).a,u(12).a);if(u(13).w>0.){let cell=vec2<i32>(floor(p/u(13).w));if(((cell.x^cell.y)&1)!=0){bg=vec4<f32>(u(13).rgb,1.);}}if(u(11).w>0.5&&u(11).z>0.13){let spacing=32.*u(11).z;var delta=p-u(11).xy;delta=delta-floor(delta/spacing)*spacing;delta=min(delta,vec2<f32>(spacing)-delta);let alpha=clamp(1.-length(delta),0.,1.)*0.4;bg=managedBackgroundOverNormal(bg,vec4<f32>(vec3<f32>(0.65,0.67,0.73)*alpha,alpha));}return bg;}
 return vec4<f32>(0);
}
@fragment fn managedBackgroundFragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{let value=managedBackgroundShade(p.xy+u(0).xy);if(u(60).z>0.5){return displayColor(value);}let mode=i32(u(4).x);if(u(60).x<0.5&&mode!=15&&mode!=16&&mode!=44){return round(clamp(value,vec4<f32>(0),vec4<f32>(1))*255.)/255.;}return value;}
`
