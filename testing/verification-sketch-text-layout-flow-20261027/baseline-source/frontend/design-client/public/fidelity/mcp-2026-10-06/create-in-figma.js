const page=figma.currentPage;
const kinds=['shadow','layer-blur','backdrop-blur'];
const existing=page.children.filter(n=>kinds.some(k=>n.name==='Forma-QA-MCP-'+k));
if(existing.length) return {alreadyExists:true,nodes:existing.map(n=>({id:n.id,name:n.name}))};
const baseX=Math.max(0,...page.children.map(n=>n.x+n.width))+96;
const made=[], frames=[];
const solid=(r,g,b,opacity=1)=>({type:'SOLID',color:{r:r/255,g:g/255,b:b/255},opacity,visible:true,blendMode:'NORMAL'});
function rectangle(parent,name,x,y,w,h,fill){
 const n=figma.createRectangle();made.push(n.id); parent.appendChild(n);n.name=name;n.resize(w,h);n.x=x;n.y=y;n.fills=[fill];n.strokes=[]; return n;
}
for(const [i,kind] of kinds.entries()){
 const f=figma.createFrame();made.push(f.id);page.appendChild(f);f.name='Forma-QA-MCP-'+kind;f.resize(128,128);f.x=baseX+i*176;f.y=0;f.fills=[solid(255,255,255)];f.strokes=[];f.clipsContent=true;f.blendMode='NORMAL';
 f.exportSettings=[{format:'PNG',constraint:{type:'SCALE',value:1},colorProfile:'SRGB',contentsOnly:true}];
 if(kind==='backdrop-blur'){
  for(const x of [0,32,64,96]) rectangle(f,'background stripe',x,0,16,128,solid(0,0,0));
  const glass=rectangle(f,'blurred surface',16.125,16.125,96,96,solid(255,255,255,.1));
  glass.effects=[{type:'BACKGROUND_BLUR',radius:4,visible:true,blurType:'NORMAL'}];
  rectangle(f,'foreground',52,52,24,24,solid(221,68,119));
 }else{
  const n=rectangle(f,'effect target',32,32,64,48,solid(68,119,221));
  n.effects=kind==='shadow'?[{type:'DROP_SHADOW',radius:4,offset:{x:0,y:4},color:{r:0,g:0,b:0,a:.25},spread:0,visible:true,blendMode:'NORMAL',showShadowBehindNode:false}]:[{type:'LAYER_BLUR',radius:4,visible:true,blurType:'NORMAL'}];
 }
 frames.push(f);
}
return {createdNodeIds:made,mutatedNodeIds:[page.id],pageId:page.id,colorProfile:figma.root.documentColorProfile,frames:frames.map(f=>({id:f.id,name:f.name,x:f.x,y:f.y,width:f.width,height:f.height,exportSettings:f.exportSettings,children:f.children.map(n=>({id:n.id,name:n.name,type:n.type,x:n.x,y:n.y,width:n.width,height:n.height,opacity:n.opacity,fills:n.fills,effects:n.effects}))}))};
