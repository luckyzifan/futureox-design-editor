"""Isolate candidate UI and checked kernel from concurrent, unrelated worktree edits."""
from pathlib import Path
import sys,json,hashlib,shutil,subprocess
w=Path(sys.argv[1]);root=Path.cwd();a=json.loads((w/'A/build-manifest.json').read_text())['sources']
def sha(p):return hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
changed=['design-studio/crates/design-kernel/src/gpu/packet.rs','design-studio/crates/design-kernel/src/gpu/frame_wire.rs']
for k,v in a.items():
 if k.startswith('design-studio/') and k not in changed: assert sha(root/k)==v,k
for f in ['bin/design-prepare','bin/design-render','sidecar/futureox-design-desktop-backend']:
 shutil.copy2(w/'B'/f,w/'frozen-B'/f)
gen=Path('frontend/design-client/src/generated/design-kernel')
for f in gen.glob('*'):
 if f.is_file():shutil.copy2(f,w/'tree'/gen/f.name)
shutil.copy2(w/'B/renderer/kernel/design_kernel_bg.wasm',w/'tree/frontend/design-client/public/kernel/design_kernel_bg.wasm')
for k,v in a.items():
 if k.startswith(('frontend/design-client/src/','frontend/design-desktop/src/')) and not k.endswith('/NativeSourceSurface.tsx'):
  assert sha(w/'tree'/k)==v,k
# Store a standalone kernel source snapshot (excluding build outputs), not a live symlink.
design=w/'tree/design-studio'
if design.is_symlink():
 design.unlink();design.mkdir()
 for p in (root/'design-studio').iterdir():
  if p.name in ('target','.DS_Store'):continue
  if p.name in ('crates','scripts') and p.is_dir():subprocess.run(['cp','-cR',str(p),str(design/p.name)],check=True)
  elif p.is_file():shutil.copy2(p,design/p.name)
  else:(design/p.name).symlink_to(p)
manifest=dict(format='fixed-density-controlled-build',baseline=w.joinpath('A/build-manifest.json').name,
              changed={k:sha(w/'tree'/k) for k in [*changed,'frontend/design-client/src/kernel/NativeSourceSurface.tsx','frontend/design-client/src/kernel/source-tile-retirement.ts']},
              host='identical frozen G',unrelatedLiveInputsExcluded=[k for k,v in a.items() if k not in changed and k!='frontend/design-client/src/kernel/NativeSourceSurface.tsx' and (root/k).is_file() and sha(root/k)!=v])
(w/'frozen-B/benchmark-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
