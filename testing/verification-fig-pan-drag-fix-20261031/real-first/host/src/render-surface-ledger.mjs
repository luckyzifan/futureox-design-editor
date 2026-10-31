// Failure-only bounded physical-texture inventory. Never reads document keys or GPU contents.
export const SURFACE_SCAN_STEPS = 4096
export const SURFACE_SCAN_UNIQUE = 1024
const MAX_BYTES = 17179869184
export const SurfaceMembership = Object.freeze({ busy:1, free:2, used:4, coordinate:8, retired:16, interaction:32, image:64 })
// Fixed acquire callsites; a tag describes the latest pool hand-out, not lifetime ownership.
export const SurfaceAllocationSite = Object.freeze({ unknown:0, transparentZero:1, empty:2, painterExpand:3,
  painterCrop:4, passOutput:5, pathCoverage:6, nodeMask:7, boundedImageOutput:8,
  streamImageOutput:9, streamImageBefore:10, streamImageSource:11, filterSourceMask:12,
  byteShadowOutput:13, byteShadowSource:14, filterImageMask:15, isolatedHorizontal:16,
  filterTableResolve:17, filterRegionResolve:18, isolatedBlurOutput:19, displayMaterialMask:20,
  displayImageMask:21, sequentialFrame:22, displayBackdropStripReuse:23, displayBackdropStripNew:24,
  displayBackdropSource:25, displayBackdropHorizontal:26, displayBackdropOutput:27,
  textureReplayOutput:28, atlasPage:29 })
const roles = [0,1,1,9,9,2,3,3,4,4,4,4,3,8,8,3,5,5,5,5,3,3,6,5,5,5,5,5,7,10]
export function surfaceAllocationRole(site) { return Number.isInteger(site) ? roles[site] || 0 : 0 }
export function surfaceAllocationTag(site=0, mode=-1) {
  return Object.freeze({ site:Number.isInteger(site)&&site>=0&&site<roles.length?site:0,
    role:surfaceAllocationRole(site), mode:Number.isInteger(mode)&&mode>=0&&mode<=255?mode+1:0 })
}
const own=(value,key)=>value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max
const baseLimits={failureSurfaceSnapshotVersion:1,failureAllocationCallsite:29,failureAllocationRole:10,
 failureAllocationPassMode:256,failureSurfaceScanSteps:SURFACE_SCAN_STEPS,failureSurfaceUniqueCount:SURFACE_SCAN_UNIQUE,
 failureSurfaceScanTruncated:1,failureSurfaceScanError:1,failureSurfaceTotalsCapped:1,
 failureSurfaceInvalidCount:SURFACE_SCAN_UNIQUE,failureSurfaceMetadataConflictCount:SURFACE_SCAN_UNIQUE,
 failureSurfaceUniqueBytes:MAX_BYTES,failureSurfaceLedgerResidualBytes:MAX_BYTES,failureSurfaceLedgerOvercountBytes:MAX_BYTES,
 failureSurfaceLargestBytes:MAX_BYTES,failureSurfaceLargestWidth:1e9,failureSurfaceLargestHeight:1e9,
 failureSurfaceLargestRole:10,failureSurfaceLargestCallsite:29,failureSurfaceLargestPassMode:256}
for(const group of ['Busy','Free','Used','Pinned','Overlap','AliasProtected','PoolCompleted','PoolPending','PoolEpochUnknown']) {
 baseLimits[`failureSurface${group}Count`]=SURFACE_SCAN_UNIQUE;baseLimits[`failureSurface${group}Bytes`]=MAX_BYTES
}
for(let i=0;i<=10;i++){baseLimits[`failureSurfaceRole${i}Count`]=SURFACE_SCAN_UNIQUE;baseLimits[`failureSurfaceRole${i}Bytes`]=MAX_BYTES}
for(let i=1;i<=9;i++){baseLimits[`failureSurfaceClass${i}Count`]=SURFACE_SCAN_UNIQUE;baseLimits[`failureSurfaceClass${i}Bytes`]=MAX_BYTES}
for(let i=1;i<=5;i++){baseLimits[`failureSurfaceSize${i}Count`]=SURFACE_SCAN_UNIQUE;baseLimits[`failureSurfaceSize${i}Bytes`]=MAX_BYTES}
const limits=Object.entries(baseLimits)
export function sanitizeSurfaceLedger(value) {
 try {
  if(own(value,'failureSurfaceSnapshotVersion')!==1)return {}
  const out={}
  for(const [key,max] of limits){const n=own(value,key);if(integer(n,max))out[key]=n}
  return out
 } catch{return {}}
}
export function snapshotSurfaceLedger(input) {
 const out={failureSurfaceSnapshotVersion:1,failureSurfaceScanSteps:0,failureSurfaceUniqueCount:0,
  failureSurfaceScanTruncated:0,failureSurfaceScanError:0,failureSurfaceTotalsCapped:0,
  failureSurfaceInvalidCount:0,failureSurfaceMetadataConflictCount:0,failureSurfaceUniqueBytes:0}
 const unique=new Map();let stopped=false
 const add=(key,n)=>{const sum=(out[key]||0)+n;if(sum>MAX_BYTES)out.failureSurfaceTotalsCapped=1;out[key]=Math.min(sum,MAX_BYTES)}
 const group=(name,bytes)=>{add(`failureSurface${name}Count`,1);add(`failureSurface${name}Bytes`,bytes)}
 const visit=(texture,mask)=>{
  if(!texture||typeof texture!=='object')return
  const resource=own(texture,'resource'),identity=resource&&typeof resource==='object'?resource:texture
  let entry=unique.get(identity)
  if(!entry){
   if(unique.size>=SURFACE_SCAN_UNIQUE){out.failureSurfaceScanTruncated=1;stopped=true;return}
   entry={texture,mask:0,bytes:0,width:0,height:0,invalid:false,conflict:false,observed:false,tag:surfaceAllocationTag(),alias:false,pinned:false,material:false,coverage:false};unique.set(identity,entry)
  }
  const bytes=own(texture,'bytes'),width=own(texture,'width'),height=own(texture,'height')
  if(!integer(bytes,MAX_BYTES)||!integer(width,1e9)||!integer(height,1e9)){entry.invalid=true;return}
  if(entry.observed&&(entry.bytes!==bytes||entry.width!==width||entry.height!==height))entry.conflict=true
  if(bytes>=entry.bytes){entry.bytes=bytes;entry.width=width;entry.height=height}
  entry.observed=true;entry.mask|=mask;entry.alias ||= input.aliases(texture)>1;entry.pinned ||= !!input.pinned(texture)
  entry.material ||= !!input.material(texture);entry.coverage ||= !!input.coverage(texture)
  const tag=input.tag(texture)
  if(tag){if(entry.tag.site&&(entry.tag.site!==tag.site||entry.tag.mode!==tag.mode))entry.conflict=true;entry.tag=surfaceAllocationTag(tag.site,tag.mode?tag.mode-1:-1)}
 }
 // Count every iterator advance, including empty pool lists; duplicate aliases cannot evade the bound.
 const scan=(items,work)=>{
  const iterator=items[Symbol.iterator]()
  while(!stopped){
   if(out.failureSurfaceScanSteps>=SURFACE_SCAN_STEPS){out.failureSurfaceScanTruncated=1;stopped=true;break}
   const next=iterator.next();out.failureSurfaceScanSteps++;if(next.done)break;work(next.value)
  }
 }
 try {
  for(const source of input.sources){
   if(stopped)break
   const take=value=>visit(source.surface?own(value,'texture'):value,source.mask)
   if(source.nested)scan(source.items,list=>scan(list,take));else scan(source.items,take)
  }
  for(const e of unique.values()){
   const b=e.bytes,m=e.mask;out.failureSurfaceUniqueCount++;add('failureSurfaceUniqueBytes',b)
   if(e.invalid)out.failureSurfaceInvalidCount++;if(e.conflict)out.failureSurfaceMetadataConflictCount++
   if(m&1)group('Busy',b);if(m&2)group('Free',b);if(m&4)group('Used',b)
   if(e.pinned||e.alias||m&32)group('Pinned',b);if(e.alias)group('AliasProtected',b)
   if(m&&(m&(m-1)))group('Overlap',b)
   if(m&2){const epoch=input.poolEpoch(e.texture),done=input.completedEpoch
    group(!integer(epoch,Number.MAX_SAFE_INTEGER)||epoch<1||!integer(done,Number.MAX_SAFE_INTEGER)?'PoolEpochUnknown':epoch<=done?'PoolCompleted':'PoolPending',b)}
   const category=e.material?1:e.coverage?2:m&32?3:m&8?4:m&16?5:m&64?6:m&2?7:m&1?8:9
   group(`Class${category}`,b);group(`Role${e.tag.role}`,b)
   const side=Math.max(e.width,e.height);group(`Size${side<=512?1:side<=1024?2:side<=2048?3:side<=4096?4:5}`,b)
   if(b>(out.failureSurfaceLargestBytes||0))Object.assign(out,{failureSurfaceLargestBytes:b,failureSurfaceLargestWidth:e.width,
    failureSurfaceLargestHeight:e.height,failureSurfaceLargestRole:e.tag.role,failureSurfaceLargestCallsite:e.tag.site,failureSurfaceLargestPassMode:e.tag.mode})
  }
  const ledger=integer(input.ledgerBytes,MAX_BYTES)?input.ledgerBytes:0
  out.failureSurfaceLedgerResidualBytes=Math.max(0,ledger-out.failureSurfaceUniqueBytes)
  out.failureSurfaceLedgerOvercountBytes=Math.max(0,out.failureSurfaceUniqueBytes-ledger)
 }catch{out.failureSurfaceScanError=1;out.failureSurfaceScanTruncated=1}
 return sanitizeSurfaceLedger(out)
}
