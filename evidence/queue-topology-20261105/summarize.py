"""Collect measurements without selecting a best run. Run from the repository root."""
import gzip, hashlib, json, pathlib, statistics, subprocess, sys
w=pathlib.Path(sys.argv[1]);out=pathlib.Path(__file__).resolve().parent;root=out.parents[1]
read=lambda p:json.loads(p.read_text())
def write(name,value): (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def zipped(name,raw): (out/name).write_bytes(gzip.compress(raw,mtime=0))
def lines(p):return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
def med(xs):return round(statistics.median(xs),3)
def device(rows):
 groups={}
 for name,g in [('dense',rows[:6]),('visible3200',rows[6:10]),('edge3200',rows[10:])]:
  groups[name]={'channels':sum(r['channels'] for r in g),'mismatchingChannels':sum(r['diff'] for r in g)}
  for i,arm in enumerate('AB'):
   groups[name][arm]={k:round((max if k=='peak' else sum)(med([s[k] for s in row['arms'][i]['samples']]) for row in g),2) for k in ['complete','graph','checkpoint','finish','tail','peak','draws','passes','submits']}
 return groups
def profile(rows):
 g={}
 for key,items in [('dense',rows[:6]),('visible3200',rows[6:10]),('edge3200',rows[10:])]:
  waits={}
  for r in items:
   for name,z in r['blocking'].items():
    pair=waits.setdefault(name,[0,0]);pair[0]+=z['count'];pair[1]+=z['wallMs']
  fields=[z for r in items for z in r['details']['fields']];batches=[z for r in items for z in r['details']['pairs']]
  g[key]={'frames':len(items),'nativeDensePayload':sum(r['dense'] for r in items),'pairBatchAttempts':len(batches),'batchOutcomes':{n:sum(z['outcome']==n for z in batches) for n in sorted(set(z['outcome'] for z in batches))},
    'effectPairOutcomes':{k:sum(r['profile'].get(k,{}).get('count',0) for r in items) for k in ['pair.effect.paired','pair.effect.single']},
    'graphMs':round(sum(r['frame']['graph'] for r in items),2),'checkpointMs':round(sum(r['frame']['checkpoint'] for r in items),2),
    'blockingByReason':{k:{'count':v[0],'wallMs':round(v[1],2)} for k,v in waits.items()},
    'maintenanceSyncCalls':sum(r['profile']['maintenance.syncPrefix']['count'] for r in items),'maintenanceSyncMs':round(sum(r['profile']['maintenance.syncPrefix']['total'] for r in items),2),
    'shadowFields':len(fields),'zeroMaskFields':sum(f['masks']==0 and not f['groupRoots'] for f in fields),'virtualZeroFields':sum(f['zero'] for f in fields),'maxSimultaneousFieldBytes':max(r['details']['fieldPeakPhysicalBytes'] for r in items),'drawsToProduceFields':sum(z['draws'] for z in fields)}
 return g
def desktop(p):
 r=read(p/'report.json');frames=read(p/'frames.json');assert r['fileHash']=='b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12'
 ev=[]
 for l in (p/'render.log').read_text().splitlines():
  if '[render-diag] ' not in l:continue
  try:z=json.loads(l.split('[render-diag] ',1)[1])
  except ValueError:continue
  if z.get('event')=='tile':ev.append(z)
 scopes=lines(p/'scopes.ndjson');packets=lines(p/'packets.ndjson');result={}
 for s in r['segments']:
  if not s['name'].startswith(('dense-','high-')):continue
  a,e=s['begin'],s['end'];last=max([i[0] for i in frames['inputs'] if a<=i[0]<=s['up']] or [s['up']]);tiles=[t for t in ev if a<=t['at']<=e];uncached=[t for t in tiles if t.get('cached')==0]
  result[s['name']]={'ready':s.get('ready'),'camera':s['endView'],'visible':s['visible'],'afterGestureMs':round(e-s['up'],2),'afterLastInputMs':round(e-last,2),
   'scope':[{'keys':z['keys'],'nodes':z['nodes'],'relativeMs':round(z['t']-s['up'],2)} for z in scopes if z.get('status')=='ok' and a<=z['t']<=e],
   'captures':[{'startAfterGestureMs':round(q['at']-s['up'],2),'wallMs':round(q['wallMs'],2),'bytes':q.get('packetBytes',0),'mode':q['mode'],'zoom':q.get('zoom'),'viewport':q.get('viewport')} for q in packets if a<=q['at']<=e and q['method']=='compile_gpu_packet' and q.get('capture')],
   'uncachedTileRecords':len(uncached),'peakTextureBytes':max([0]+[t.get('peakTextureBytes',0) for t in tiles]),'sampledGraphMs':round(sum(t.get('graphMs',0) for t in uncached),2),'sampledCheckpointMs':round(sum(t.get('checkpointMs',0) for t in uncached),2)}
 return result
drows=read(w/'final-ab.json');write('device-summary.json',device(drows));zipped('metal-samples.json.gz',(w/'final-ab.json').read_bytes())
stats={}
for name,k in [('profile','A'),('profileB','B')]:
 p=w/('final-'+name+'.json');stats[k]=profile(read(p));zipped('allocation-and-queue-'+k+'.json.gz',p.read_bytes())
write('waits-and-lifetimes.json',stats)
for name,folder in [('gpu-only',w),('integrated-no-priority',w/'integrated'),('before-scope-review',w/'shipping'),('shipping',w/'final')]:
 rows={p.name:desktop(p) for p in sorted(folder.glob('*-?-?')) if (p/'report.json').exists() and p.name.startswith(('dense-','high-'))}
 if rows:write(name+'-desktop.json',rows)
supplement={p.name:desktop(p) for p in sorted(w.glob('cold-?-?')) if (p/'report.json').exists()}
if supplement:write('additional-cold-desktop.json',supplement)
for src,name in [('native-ab.json','native-samples.json'),('native-oracle.json','native-equivalence.json'),('desktop-pixels.json','gpu-only-pixels.json'),('desktop-pixels-C.json','integrated-pixels.json'),('cpu-final.json','cpu-117.json'),('cpu-check/qa.json','cpu-pixels.json'),('wasm-qa.log','wasm-pixels.json'),('desktop-pixels-E.json','before-scope-review-pixels.json'),('desktop-pixels-G.json','shipping-pixels.json'),('shipping-native.json','shipping-native.json'),('dense-native.json','dense-native.json'),('dense-native-oracle.json','dense-native-equivalence.json'),('shipping-native-oracle.json','shipping-native-equivalence.json'),('packets/high-requests.json','high-requests.json')]:
 p=w/src
 if p.is_file():write(name,read(p))
zipped('preparation-stack.txt.gz',(w/'native.sample').read_bytes())
for p in ['native.json']:
 zipped('native-cold-profile.json.gz',(w/p).read_bytes())
control={}
for f in ['owned','pacing','gate','slice','denseholes','cap8','uniform-gate']:
 p=w/(f+'.json')
 if not p.exists():continue
 rows=read(p)
 control[f]=device(rows)['dense'] if len(rows)>=12 else {arm:{key:(max if key=='peak' else sum)(med([s[key] for s in r['arms'][i]['samples']]) for r in rows) for key in ['complete','tail','passes','peak']} for i,arm in enumerate('AB')}
write('discarded-controls.json',control)
