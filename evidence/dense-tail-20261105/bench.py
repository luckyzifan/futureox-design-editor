"""Serial, balanced fresh-process A/B. Reject mismatched scopes before reading durations; preserve excluded rows."""
from pathlib import Path
import json,os,re,subprocess,sys,time,statistics
W=Path(sys.argv[1]);R=Path(__file__).resolve().parents[2];H=str(W/'fixed.mjs');sketch='/Users/Apple/Downloads/拓扑素材.sketch'
F=json.loads((W/'cfg.json').read_text());results=W/'runs.ndjson'
def jobs():
 out={}
 for l in subprocess.check_output(['ps','-axo','pid=,time=,comm=,args='],text=True,errors='replace').splitlines():
  # comm may contain spaces. Classify argv only for local compiler/test executables, never publish arguments.
  m=re.match(r'\s*(\d+)\s+([\d:.]+)\s+(\S+)',l)
  if not m:continue
  exe=os.path.basename(m[3]);cat=None
  if exe in ('rustc','cc1','clang','clang++','ld','wasm-opt','wasm-bindgen','swift-frontend'):cat=exe
  elif exe in ('node','bun') and re.search(r'(/vitest(\.mjs)?\b|\bvitest run\b|/tsc\b|\bvite build\b)',l):cat='frontend-build-or-test'
  if cat:
   sec=0.
   for part in m[2].split(':'):sec=sec*60+float(part)
   out[int(m[1])]=(cat,sec)
 return out
def log(v):print(json.dumps(v,ensure_ascii=False),file=results.open('a'),flush=True)
def run(label,arm,mode,opts=None):
 out=W/label;env=dict(os.environ,OVERVIEW_HOST=str(W/'host'))
 env.update(opts or {})
 if mode in ('high','high-pixels'):env.update(OVERVIEW_HIGH_ZOOM='1',OVERVIEW_HIGH_FOCUS='4',OVERVIEW_HIGH_POINT_FROM='/private/tmp/futureox-retention-topology.DbMJF0/high-B/report.json')
 else:env.update(TAIL_CAMERA=str(W/'cfg.json'))
 args=['node',H,str(W/('frozen-B' if arm=='B' else arm)),sketch,str(out)];before=jobs()
 while before:time.sleep(2);before=jobs()
 ran={}
 with (W/(label+'.log')).open('w') as f:
  p=subprocess.Popen(args,cwd=R,env=env,stdout=f,stderr=subprocess.STDOUT)
  while p.poll() is None:
   for pid,(cat,cpu) in jobs().items():ran[pid]=(cat,max(cpu,ran.get(pid,('',0))[1]))
   time.sleep(1)
 contaminated=mode!='challenge' and any(cpu>=.6 for _,cpu in ran.values())
 x={'label':label,'arm':arm,'mode':mode,'code':p.returncode,'otherWork':list(ran.values()),'contaminated':contaminated}
 if p.returncode==0:
  rep=json.loads((out/'report.json').read_text());segs={s['name']:s for s in rep['segments']};assert rep['fileHash']==F['fileHash']
  key='high-3200' if mode.startswith('high') else 'dense-cold-view'
  c=segs[key];end=segs.get('dense-inflight-return',c);scopes=[j for s in (out/'scopes.ndjson').read_text().splitlines() if (j:=json.loads(s)).get('status')=='ok' and c['begin']<=j['t']<=end['end']]
  exact=all(s['ready'] and s['endView']==F['camera'] for s in [c,end]) if not mode.startswith('high') else (c['ready'] and abs(c['endView'][2]-32)<.00001)
  fixed=exact and (mode.startswith('high') or (len(scopes)==1 and scopes[0]['keys']==F['keys'] and scopes[0]['nodes']==F['nodes']))
  x.update(scopeMatch=bool(fixed),rawPoseMatch=rep.get('rawEnd')==F['camera'],scopeNodes=[s['nodes'] for s in scopes],cold=round(c['end']-c['up'],2),returned=round(end['end']-end['up'],2))
 log(x);print(label,x,flush=True);return not p.returncode and x['scopeMatch'] and not contaminated
if __name__=='__main__':
 stage=sys.argv[2]
 if stage=='matrix':
  count=0
  for i,order in enumerate(['AB','BA','BA','AB','BA','AB','AB','BA','AB','BA','BA','AB','AB','BA','AB','BA']):
   valid=[run(f'fixed-{i+1:02}-{a}',a,'fixed') for a in order]
   if all(valid):count+=1
   if count==10:break
  assert count==10,'fewer than ten clean and scope-matched pairs'
 elif stage=='high':
  for i,order in enumerate(['BA','AB','AB','BA']):
   for a in order:assert run(f'high-{i+1}-{a}',a,'high')
 elif stage=='challenge':
  for i,load in enumerate([False,True,True,False]):
   run(f"challenge-{i+1}",'A','challenge',dict(TAIL_NATIVE_CPU=str(W/'process-meter'),TAIL_CONTEND='1' if load else '0'))
 elif stage=='oracle':
  for a in 'AB':
   assert run('pixel-dense-'+a,a,'pixels',dict(DENSE_PIXELS='1'))
   assert run('pixel-high-'+a,a,'high-pixels',dict(OVERVIEW_GUI='1'))
