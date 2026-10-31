import {blank,node,paint,effect,type DesignDocument} from './model'

export function precisionFixtures():DesignDocument[]{
 const topology=blank('精度：斜边采样与退化自交'),v=node('vector',0,0,40,36)
 const points=[[0,0],[40,36],[0,36],[40,0],[40,0],[20,0.00001],[0,0]]
 v.transform=[-1,.125,-.125,1,45.28125,7.375];v.fills=[paint('#8866dd')]
 v.network={fillRule:'evenodd',vertices:points.map(([x,y],i)=>({id:`v${i}`,x,y})),edges:points.map((_,i)=>({id:`e${i}`,from:`v${i}`,to:`v${(i+1)%points.length}`}))}
 topology.nodes[v.id]=v;topology.pages[0].children=[v.id]
 const backdrop=blank('精度：背景效果透明度取整'),a=node('ellipse',8.125,11.375,37.5,31.75),b=node('rectangle',27.875,19.625,37.5,31.75)
 a.fills=[paint('#4488cc')];b.fills=[paint('#ee9944')];b.opacity=.625;b.effects=[{...effect('background-blur'),radius:2.5}]
 for(const n of [a,b]){backdrop.nodes[n.id]=n;backdrop.pages[0].children.push(n.id)}
 const gradient=blank('精度：渐变半字节与批次切换')
 for(let i=0;i<230;i++){const n=node('rectangle',(i%16)*5+.125,Math.floor(i/16)*4+.375,7.75,6.5);n.fills=[paint(i%2?'#4477dd':'#dd6644')];if(i>=40&&i<185)n.fills=[{...paint('#4455dd','linear'),angle:0,stops:[{offset:0,color:'#4455dd'},{offset:1,color:'#dd7744'}]}];gradient.nodes[n.id]=n;gradient.pages[0].children.push(n.id)}
 const previews=[1,2].map(density=>{const d=blank(`精度：${density}×像素预览`),n=node('rectangle',12.125,9.375,37.5,31.75);n.fills=[paint('#4488cc')];d.nodes[n.id]=n;d.pages[0].children=[n.id];return d})
 return[topology,backdrop,gradient,...previews]
}
