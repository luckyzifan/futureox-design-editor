"""Additional first-entry observations after the slow cold outlier. Same real input/gesture, stop before reversal; keep all runs."""
from pathlib import Path
import subprocess,sys,os,json
w=Path(sys.argv[1]);sketch=sys.argv[2];repo=Path(__file__).resolve().parents[2]
for i,arm in enumerate('AGGA',1):
 p=w/f'cold-{i}-{arm}'
 env=dict(os.environ,OVERVIEW_HOST=str(w/'host-A'),OVERVIEW_SWEEP='1',OVERVIEW_DENSE='1')
 with (w/(p.name+'.log')).open('w') as f:
  rc=subprocess.run(['node','testing/verification-overview-zoom-20261104/replay.mjs',str(w/('product-'+arm)),sketch,str(p)],cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT).returncode
 with (w/'cold-status.ndjson').open('a') as f:print(json.dumps({'name':p.name,'code':rc}),file=f)
 if rc:raise SystemExit(rc)
