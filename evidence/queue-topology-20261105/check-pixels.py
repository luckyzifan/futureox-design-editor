"""Settle the same three dense cameras and the same 3200% camera in new A and B workspaces."""
import json,os,pathlib,subprocess,sys,hashlib
from PIL import Image,ImageChops
from PIL.ImageStat import Stat
work=pathlib.Path(sys.argv[1]);asset=sys.argv[2];repo=pathlib.Path(__file__).resolve().parents[2]
oracle=work/'oracle.mjs'
subprocess.run([sys.executable,'evidence/retention-topology-20261105/camera-oracle.py',str(oracle)],cwd=repo,check=True)
candidate=sys.argv[3] if len(sys.argv)>3 else 'B'
for scenario in ['dense','high']:
 for arm in (candidate if len(sys.argv)>3 else 'AB'):
  env=dict(os.environ,OVERVIEW_HOST=str(work/'host-A'),OVERVIEW_ORACLE_FROM=str(work/f'{scenario}-1-A'/'report.json'),OVERVIEW_GUI='1')
  p=work/f'oracle-{scenario}-{arm}'
  with open(str(p)+'.log','w') as log:subprocess.run(['node',str(oracle) if scenario=='dense' else 'testing/verification-overview-zoom-20261104/replay.mjs',str(work/('product-'+arm)),asset,str(p)],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
rows=[]
for name in ['dense-settled','dense-shifted','dense-return','high-3200']:
 scenario=name.split('-')[0];a,b=[work/f'oracle-{scenario}-{arm}' for arm in ['A',candidate]]
 for suffix in ['-native','']:
  images=[Image.open(p/(name+suffix+'.png')).convert('RGBA') for p in [a,b]]
  if images[0].size!=images[1].size:raise ValueError('size mismatch')
  changes=ImageChops.difference(*images); bands=changes.split();m=bands[0]
  for band in bands[1:]:m=ImageChops.lighter(m,band)
  rows.append(dict(name=name,plane='native' if suffix else 'window-crop',size=images[0].size,different=sum(m.histogram()[1:]),maxChannelError=m.getextrema()[1],box=m.getbbox(),hashes=[hashlib.sha256(x.tobytes()).hexdigest() for x in images]))
(work/('desktop-pixels'+('-'+candidate if len(sys.argv)>3 else '')+'.json')).write_text(json.dumps(rows,indent=2)+'\n')
