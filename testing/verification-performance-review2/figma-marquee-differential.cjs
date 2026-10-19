const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const root=path.resolve(__dirname,'../../frontend/design-client/src');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
function compile(text,required={}) {
 const names=[...text.matchAll(/export (?:function|const) (\w+)/g)].map(m=>m[1]);
 const output=stripTypeScriptTypes(text).replace(/import \{([^}]+)\} from ['"]([^'"]+)['"]/g,(_,imports,name)=>{
  assert.ok(name in required);return `const {${imports}} = required[${JSON.stringify(name)}]`;
 }).replace(/export (function|const) /g,'$1 ');
 const exports={};vm.runInNewContext(output+'\n'+names.map(n=>`exports.${n}=${n};`).join('\n'),{exports,required});return exports;
}
const geomText=read('geometry.ts'),geo=compile(geomText.slice(geomText.indexOf('export const intersects ='),geomText.indexOf('export const contains ='))+'\n'+geomText.slice(geomText.indexOf('export function allParents('),geomText.indexOf('export function worldMatrix(')));
const hierarchy=compile(read('selection-hierarchy.ts'),{'./geometry':geo});
const source=read('canvas-selection-workflows.ts'),after=compile(source,{'./geometry':geo,'./selection-hierarchy':hierarchy}).canvasMarqueeSelection;
let oldText=fs.readFileSync(path.join(__dirname,'fixtures/figma-marquee.before.txt'),'utf8');
oldText=oldText.replace('const deep = e.metaKey || e.ctrlKey','const deep = options.deep').replaceAll('editor.state.doc','document').replaceAll('editor.state.page','page').replaceAll('d.originSelection','origin').replaceAll('(d.pickIndex || index).query(area)','entries').replaceAll('d.additive','options.additive').replace('editor.select(', 'return [...new Set(').replace(/\)\s*$/,')];');
const before=new Function('document','page','origin','entries','area','options','allParents','marqueeScope','intersects','interactivePath',oldText);
const badSource=source.replace('interactivePath(document, page, entry.id, false, parents).length > 0','true');assert.notEqual(badSource,source);
const mutant=compile(badSource,{'./geometry':geo,'./selection-hierarchy':hierarchy}).canvasMarqueeSelection;
let seed=0x4826ba13;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
let comparisons=0,nonempty=0,mutationsCaught=0;
for(let scene=0;scene<3000;scene++){
 const document={pages:[{id:'p',children:[]},{id:'q',children:[]}],nodes:{}}, entries=[];
 const count=5+Math.floor(rand()*30);
 for(let n=0;n<count;n++){
  const id='n'+n,parent=n&&rand()<.7?'n'+Math.floor(rand()*n):rand()<.9?'p':'q';
  document.nodes[id]={id,children:[],visible:rand()>.15,locked:rand()<.15,kind:rand()<.5?'group':'frame'};
  if(parent==='p'||parent==='q')document.pages.find(p=>p.id===parent).children.push(id);else document.nodes[parent].children.push(id);
  const ancestors=parent==='p'||parent==='q'?[]:[...entries.find(e=>e.id===parent).ancestors,parent];
  entries.push({id,ancestors,locked:document.nodes[id].locked,bounds:{x:Math.floor(rand()*150)-25,y:Math.floor(rand()*150)-25,width:5+Math.floor(rand()*60),height:5+Math.floor(rand()*60)}});
 }
 const origin=entries.filter(()=>rand()<.15).map(e=>e.id),area={x:0,y:0,width:100,height:100};
 for(const deep of [false,true])for(const additive of [false,true]){
  const options={deep,additive,contained:false,toggle:false};
  const expected=before(document,'p',origin,entries,area,options,geo.allParents,hierarchy.marqueeScope,geo.intersects,hierarchy.interactivePath);
  const actual=Array.from(after(document,'p',origin,entries,area,options));assert.deepStrictEqual(actual,expected);
  comparisons++;if(actual.length)nonempty++;
  try{assert.deepStrictEqual(Array.from(mutant(document,'p',origin,entries,area,options)),expected)}catch{mutationsCaught++}
 }
}
assert.ok(nonempty>1000);assert.ok(mutationsCaught>1000);
console.log(JSON.stringify({status:'passed',scenes:3000,comparisons,nonempty,negativeControl:{removedAncestorEligibility:mutationsCaught},currentSourceSha256:crypto.createHash('sha256').update(source).digest('hex'),baseline:'Exact extracted pre-expansion Canvas marquee expression plus Editor.select deduplication',scope:'Existing Figma selection order and eligibility only; CPU JavaScript; no browser/GPU'},null,2));
