from pathlib import Path
import hashlib,json,subprocess,datetime
wt=Path(__file__).resolve().parents[2];main=Path('/Users/Apple/project/design-kernel');out=Path(__file__).resolve().parent
base=json.loads((out/'baseline.json').read_text())['files'];sha=lambda b:hashlib.sha256(b).hexdigest();plans=[]
for name,old in base.items():
 p=wt/name
 if not p.is_file() or sha(p.read_bytes())==old:continue
 q=main/name;before=q.read_bytes();candidate=p.read_bytes();method='hash-guard'
 if sha(before)!=old:
  b=out/'baseline-source'/name;assert b.exists() and sha(b.read_bytes())==old,('missing exact baseline',name)
  merge=out/'merge';merge.mkdir(exist_ok=True);stem=name.replace('/','__');(merge/(stem+'.ours')).write_bytes(before);(merge/(stem+'.theirs')).write_bytes(candidate)
  r=subprocess.run(['git','merge-file','-p',str(merge/(stem+'.ours')),str(b),str(merge/(stem+'.theirs'))],capture_output=True)
  assert r.returncode==0,('merge conflict',name);candidate=r.stdout;(merge/(stem+'.merged')).write_bytes(candidate);method='three-way'
 plans.append((name,before,candidate,method))
new=['design-studio/crates/design-kernel/src/zoom_blur.rs','design-studio/crates/design-kernel/src/zoom_support.rs','design-studio/crates/design-kernel/src/noise_fill.rs','design-studio/crates/design-kernel/tests/zoom_blur.rs','design-studio/crates/design-kernel/tests/noise_fill.rs','design-studio/crates/design-kernel/examples/sketch_zoom_noise_fixture.rs','frontend/design-client/src/zoom-noise.test.tsx','frontend/design-client/src/kernel/gpu/zoom-blur-check.ts','frontend/design-client/zoom-blur-check.html']
for name in new:
 assert not (main/name).exists(),('new path exists',name);plans.append((name,None,(wt/name).read_bytes(),'new'))
manifest=[]
for name,before,after,method in plans:
 p=main/name;assert (p.read_bytes() if p.exists() else None)==before,('write race',name)
 if before is not None:
  b=out/'before'/name;b.parent.mkdir(parents=True,exist_ok=True);b.write_bytes(before)
 p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(after)
 manifest.append({'path':name,'before':sha(before) if before is not None else None,'after':sha(after),'method':method})
(out/'integration.json').write_text(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':manifest,'scope':'Zoom/noise third group; inherited changes excluded'},indent=2));print('Applied',len(manifest),'files')
