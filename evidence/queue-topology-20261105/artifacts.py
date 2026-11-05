"""Fingerprint the actual loaded executables, public WASM and entry/worker JS, plus incremental source provenance."""
from pathlib import Path
import hashlib,json,sys,subprocess,difflib
w=Path(sys.argv[1]);root=Path.cwd();out=Path(__file__).resolve().parent
hashf=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
sources=json.loads((w/'product-A/build-manifest.json').read_text())['sources']
def products(d):
 files=[d/'renderer/index.html',d/'renderer/kernel/design_kernel_bg.wasm',*sorted((d/'bin').glob('*')),*sorted((d/'sidecar').glob('*')), *sorted((d/'renderer/assets').glob('render-worker-*.js'))]
 return {str(f.relative_to(d)):hashf(f) for f in files if f.is_file()}
prods={a:products(w/('product-'+a)) for a in 'ABCEG' if (w/('product-'+a)/'renderer/index.html').is_file()}
(out/'products.json').write_text(json.dumps(prods,indent=2)+'\n')
files=['design-studio/crates/design-kernel/src/path.rs','frontend/design-client/src/LargeDocumentWorkspace.tsx','frontend/design-client/src/source-opening-preview.tsx',*['frontend/design-client/src/kernel/'+n for n in ['gpu/dense-batch.ts','gpu/renderer.ts','gpu/source-layer.ts','gpu/webgpu.ts','gpu/raster-queue-pacer.ts','NativeSourceSurface.tsx','source-viewport-plan.ts','gpu/dense-batch.test.ts','gpu/raster-queue-pacer.test.ts','gpu/source-layer.test.ts','gpu/source-filter-zero.test.ts','source-quality-ladder.test.ts']]]
src={};patch=[]
for f in files:
 a=w/'pre'/Path(f).name
 if not a.is_file():
  # Baseline for the uncommitted surface and viewport planner is in the frozen pre-priority product source map.
  found=False
  if Path(f).name in ['NativeSourceSurface.tsx','source-viewport-plan.ts','source-layer.ts','LargeDocumentWorkspace.tsx','source-opening-preview.tsx']:
   for m in sorted((w/'product-A/renderer/assets').glob('*.js.map')):
    if not Path(f).name.encode() in m.read_bytes():continue
    o=json.loads(m.read_text())
    for n,v in zip(o['sources'],o.get('sourcesContent',[])):
     if v and n.endswith('/'+Path(f).name) and hashlib.sha256(v.encode()).hexdigest()==sources.get(f):
      a.write_text(v);found=True;break
    if found:break
  if not found:
   proc=subprocess.run(['git','show',':'+f],capture_output=True)
   if proc.returncode==0 and ((sources.get(f) is None) or hashlib.sha256(proc.stdout).hexdigest()==sources.get(f)):a.write_bytes(proc.stdout)
 before=a.read_text() if a.exists() else ''
 old=hashlib.sha256(before.encode()).hexdigest() if a.exists() else None
 if f in sources:assert old==sources[f],f
 current=(root/f).read_text();src[f]={'before':old,'after':hashf(root/f)}
 patch.extend(difflib.unified_diff(before.splitlines(True),current.splitlines(True),fromfile=('a/'+f if old else '/dev/null'),tofile='b/'+f))
(out/'source-sha256.json').write_text(json.dumps(src,indent=2)+'\n');(out/'source.patch').write_text(''.join(patch))
