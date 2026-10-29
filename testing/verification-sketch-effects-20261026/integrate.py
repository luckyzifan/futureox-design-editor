from pathlib import Path
import hashlib,json,shutil,datetime
root=Path(__file__).resolve().parents[2]
main=Path('/Users/Apple/project/design-kernel')
out=Path(__file__).resolve().parent
base=json.loads((out/'baseline.json').read_text())['files']
sha=lambda b:hashlib.sha256(b).hexdigest()
plans=[]
for name,old in base.items():
 p=root/name
 if not p.is_file() or sha(p.read_bytes())==old:continue
 target=main/name;current=target.read_bytes();candidate=p.read_bytes()
 merged=out/'merge'/(name.replace('/','__')+'.merged')
 if merged.exists():
  assert current==(out/'merge'/(name.replace('/','__')+'.ours')).read_bytes(),('main changed',name)
  assert candidate==(out/'merge'/(name.replace('/','__')+'.theirs')).read_bytes(),('candidate changed',name)
  candidate=merged.read_bytes()
 else:assert sha(current)==old,('main diverged',name)
 plans.append((name,current,candidate))
for name in ['design-studio/crates/design-kernel/src/spatial_blur.rs','design-studio/crates/design-kernel/tests/spatial_blur.rs','frontend/design-client/src/spatial-blur.test.tsx','frontend/design-client/spatial-blur-check.html','frontend/design-client/src/kernel/gpu/spatial-blur-check.ts','testing/fixtures/design/sketch-spatial-blur-modern.sketch']:
 p=main/name;assert not p.exists(),('new path exists',name);plans.append((name,None,(root/name).read_bytes()))
name='design-studio/crates/design-kernel/examples/sketch_canvas_oracle.rs'
original=(main/name).read_bytes();candidate=(root/name).read_bytes()
assert candidate.decode().replace('    let transparent = args.next().as_deref() == Some("--transparent");\n','').replace('"transparent":transparent','"transparent":false')==original.decode()
plans.append((name,original,candidate))
manifest=[]
# Validate everything first, then hash-guard every individual write.
for name,current,candidate in plans:
 target=main/name
 assert (target.read_bytes() if target.exists() else None)==current,('write race',name)
 if current is not None:
  backup=out/'before'/name;backup.parent.mkdir(parents=True,exist_ok=True);backup.write_bytes(current)
 target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(candidate)
 manifest.append({'path':name,'before':None if current is None else sha(current),'after':sha(candidate),'threeWayMerge':(out/'merge'/(name.replace('/','__')+'.merged')).exists()})
(out/'integration.json').write_text(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':manifest,'scope':'Second group only; inherited changes and symlinked dependencies excluded'},indent=2))
print('Applied',len(manifest),'files; verified all baseline hashes before writes.')
