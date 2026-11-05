"""Independent processes, 117 real overview; warm-frame medians, Darwin process high-water marks."""
import json,re,statistics,subprocess,sys,pathlib
w=pathlib.Path(sys.argv[1]);font=sys.argv[2];d=w/'cpu-check';rows={}
for side in [512,1024,2048]:
 r=[]
 for arm in 'ABBA':
  p=subprocess.run(['/usr/bin/time','-l',d/arm,'measure',d/'117.json',d/f'117-overview-{side}.json',font],capture_output=True,text=True,check=True)
  frames=json.loads(p.stdout);assert all(f['tiles']==(side//512)**2 for f in frames)
  n=lambda key:int(re.search(r'^\s*(\d+)\s+'+key+r'\s*$',p.stderr,re.M).group(1))
  r.append(dict(arm=arm,frames=frames,rss=n('maximum resident set size'),footprint=n('peak memory footprint')))
 rows[str((side//512)**2)]=r
 (w/'cpu-final.json').write_text(json.dumps(rows,indent=2)+'\n')
