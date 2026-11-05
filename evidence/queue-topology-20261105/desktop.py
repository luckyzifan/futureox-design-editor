"""Fresh profiles, one Electron/raster owner at a time. No readback during timing."""
import json, os, pathlib, subprocess, sys, time
work=pathlib.Path(sys.argv[1]); sketch,reference=sys.argv[2:4]
root=pathlib.Path(__file__).resolve().parents[2]
order=sys.argv[4] if len(sys.argv)>4 else 'ABBA'
for i,arm in enumerate(order,1):
 for scenario in (['dense','high'] if i%2 else ['high','dense']):
  name=f'{scenario}-{i}-{arm}'; out=work/name
  env=dict(os.environ,OVERVIEW_HOST=str((work/'host-A').resolve()))
  if scenario=='dense':env.update(OVERVIEW_SWEEP='1',OVERVIEW_DENSE='1',DENSE_REVERSAL='1',DENSE_RETARGET='1')
  else:env.update(OVERVIEW_HIGH_ZOOM='1',OVERVIEW_HIGH_FOCUS='4',OVERVIEW_HIGH_POINT_FROM=reference)
  start=time.time()
  with open(work/(name+'.log'),'w') as log:
   p=subprocess.run(['node','testing/verification-overview-zoom-20261104/replay.mjs',str((work/('product-'+arm)).resolve()),sketch,str(out)],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
  with open(work/'desktop-status.ndjson','a') as f:print(json.dumps(dict(name=name,code=p.returncode,seconds=round(time.time()-start,1))),file=f,flush=True)
  if p.returncode: print(name,'failed; see log',flush=True)
