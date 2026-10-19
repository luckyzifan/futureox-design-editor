const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '../../frontend/design-client/src') + path.sep;
const source = fs.readFileSync(root+'geometry.ts','utf8');
const model = fs.readFileSync(root+'model.ts','utf8');
const identity = model.split('\n').find(line => line.startsWith('export const identity ='));
assert.ok(identity);
const needed = identity + '\n' + source.slice(source.indexOf('export function multiply('),source.indexOf('export function inverse(')) + '\n' + source.slice(source.indexOf('export function allParents('),source.indexOf('export function preciseHit('));
function compile(text, required={}) {
 const names = [...text.matchAll(/export (?:function|const) (\w+)/g)].map(m=>m[1]);
 const output=stripTypeScriptTypes(text,{mode:'strip'}).replace(/import \{([^}]+)\} from ['"]([^'"]+)['"]/g,(_,imports,name)=>{
  assert.ok(name in required);return `const {${imports}} = required[${JSON.stringify(name)}]`;
 }).replace(/export (function|const) /g,'$1 ');
 const exports={};vm.runInNewContext(output+'\n'+names.map(n=>`exports.${n}=${n};`).join('\n'),{exports,required});return exports;
}
const geom=compile(needed);let scans=0;
const countGeom={...geom,allParents:(doc)=>{scans++;return geom.allParents(doc)}};
const oldText=fs.readFileSync(path.join(__dirname,'fixtures/property-units.before.ts'),'utf8');
const newText=fs.readFileSync(root+'property-units.ts','utf8');
const old=compile(oldText,{'./geometry':geom});const actual=compile(newText,{'./geometry':countGeom});
let seed=0x18b42, compared=0, staleControls=0;
const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/2**32};
const exact=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.is(a[k],b[k]));
for(let fixture=0;fixture<1200;fixture++) {
 const count=5+Math.floor(rand()*20),doc={pages:[{id:'p',children:[]}],nodes:{}};
 for(let n=0;n<count;n++) {
  const id='n'+n,a=rand()*Math.PI*2,sx=.1+rand()*5,sy=.1+rand()*5,skew=rand()-.5;
  doc.nodes[id]={id,children:[],transform:[Math.cos(a)*sx,Math.sin(a)*sx,Math.cos(a)*skew-Math.sin(a)*sy,Math.sin(a)*skew+Math.cos(a)*sy,rand()*1e5,rand()*1e5]};
  if(n&&rand()<.8)doc.nodes['n'+Math.floor(rand()*n)].children.push(id);else doc.pages[0].children.push(id);
 }
 const start=scans,reader=actual.propertyUnitReader(doc);
 for(const id of Object.keys(doc.nodes)) {
  const expected=old.propertyUnits(doc,id),got=reader(id);
  assert.ok(exact(expected,got),`Fixture ${fixture}, ${id}`);assert.equal(reader(id),got);compared++;
 }
 assert.equal(scans-start,1,'One parent scan per reader');
 const oldUnit=reader('n0');doc.nodes.n0.transform[0]*=1.75;doc.nodes.n0.transform[1]*=1.75;
 const fresh=actual.propertyUnitReader(doc)('n0'),expected=old.propertyUnits(doc,'n0');
 assert.ok(exact(fresh,expected));assert.ok(exact(actual.propertyUnits(doc,'n0'),expected),'Default propertyUnits must remain uncached');
 if(!exact(oldUnit,expected))staleControls++;
}
assert.equal(staleControls,1200,'A deliberately retained old reader must disagree after every changed root transform');
console.log(JSON.stringify({status:'passed',sourceSha256:crypto.createHash('sha256').update(newText).digest('hex'),fixtures:1200,comparedNodes:compared,comparison:'Object.is every computed unit',topologyScansPerReader:1,negativeControl:{mutation:'reuse old reader after in-place transform change',mismatches:staleControls},scope:'Actual scoped reader/propertyUnits + actual production allParents/worldMatrix/multiply; no browser/GPU claim'},null,2));
