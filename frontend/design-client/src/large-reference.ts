import { blank, node, paint, type DesignNode } from './model'
import { networkD } from './geometry'
function explicitCurve(n:DesignNode, ellipse:boolean, r=0) {
  const w=n.width,h=n.height,k=0.55
  const points=ellipse?[[w,h/2],[w/2,h],[0,h/2],[w/2,0]]:[[r,0],[w-r,0],[w,r],[w,h-r],[w-r,h],[r,h],[0,h-r],[0,r]]
  const controls:Record<number,number[][]>=ellipse?{
    0:[[w,h/2+k*h/2],[w/2+k*w/2,h]],1:[[w/2-k*w/2,h],[0,h/2+k*h/2]],
    2:[[0,h/2-k*h/2],[w/2-k*w/2,0]],3:[[w/2+k*w/2,0],[w,h/2-k*h/2]],
  }:{1:[[w-r+k*r,0],[w,r-k*r]],3:[[w,h-r+k*r],[w-r+k*r,h]],5:[[r-k*r,h],[0,h-r+k*r]],7:[[0,r-k*r],[r-k*r,0]]}
  n.kind='vector'
  n.network={fillRule:'evenodd',vertices:points.map(([x,y],i)=>({id:`v${i}`,x,y})),edges:points.map((_,i)=>({id:`e${i}`,from:`v${i}`,to:`v${(i+1)%points.length}`,...(controls[i]?{c1:{x:controls[i][0][0],y:controls[i][0][1]},c2:{x:controls[i][1][0],y:controls[i][1][1]}}:{})}))}
  return networkD(n.network,true)
}

// Shared geometry for a real Figma SVG import and the native/GPU reference.
// Keep the SVG independent of our compatibility renderer's filter semantics.
export function largeReference() {
  const doc=blank('Core-QA-LargeNested-20261006'),frame=node('frame',0,0,1024,768)
  frame.fills=[paint('#ffffff')]
  doc.nodes[frame.id]=frame;doc.pages[0].children=[frame.id]
  const add=(n:DesignNode,parent=frame)=>{doc.nodes[n.id]=n;parent.children.push(n.id);return n}
  const svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768"><rect width="1024" height="768" fill="#ffffff"/>']
  for(let i=0;i<280;i++){
    const x=16+(i%20)*48,y=16+Math.floor(i/20)*48,opacity=i%7?1:0.875
    const g=add(node('group',x,y,40,40));g.fills=[];g.blend='pass-through';g.opacity=opacity
    const color=i%3===0?'#4477cc':i%3===1?'#cc7744':'#559977'
    const a=add(node('rectangle',0,0,36,32),g);a.fills=[paint(color)];a.radii=[6,6,6,6]
    const b=add(node('ellipse',12.125,16.125,24,20),g);b.fills=[{...paint('#eecc77'),opacity:0.55}]
    svg.push(`<g id="Cell${i}" transform="translate(${x} ${y})" opacity="${opacity}"><path d="${explicitCurve(a,false,6)}" fill="${color}"/><path d="${explicitCurve(b,true)}" transform="translate(12.125 16.125)" fill="#eecc77" fill-opacity="0.55"/></g>`)
  }
  let parent=frame
  for(let i=0;i<36;i++){
    const x=i?0.125:820,y=i?0.125:680
    const g=add(node('group',x,y,160,64),parent);g.fills=[];g.blend='pass-through';parent=g
    svg.push(`<g id="Depth${i}" transform="translate(${x} ${y})">`)
  }
  const a=add(node('ellipse',0,0,60,48),parent);a.fills=[paint('#4477dd')]
  const b=add(node('rectangle',32.125,12.125,88,40),parent);b.fills=[{...paint('#dd4477'),opacity:0.625}];b.radii=[8,8,8,8]
  svg.push(`<path d="${explicitCurve(a,true)}" fill="#4477dd"/><path d="${explicitCurve(b,false,8)}" transform="translate(32.125 12.125)" fill="#dd4477" fill-opacity="0.625"/>`,'</g>'.repeat(36),'</svg>')
  return {doc,svg:svg.join('')}
}
