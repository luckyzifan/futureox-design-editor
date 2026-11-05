"""Summarize the real Electron runs, keeping timing, scope and pixel evidence separate."""
import hashlib,json,statistics,sys
from pathlib import Path

work, dest = map(Path,sys.argv[1:3])
def read(p):return json.loads(p.read_text())
def lines(p):return [json.loads(l) for l in p.read_text().splitlines() if l] if p.exists() else []
def median(xs):return statistics.median(xs)
def measure(p):
    report=read(p/'report.json');frames=read(p/'frames.json')
    events=[]
    for line in (p/'render.log').read_text().splitlines():
        if '[render-diag] ' in line:
            try: e=json.loads(line.split('[render-diag] ',1)[1])
            except ValueError:continue
            if e.get('event')=='tile':events.append(e)
    packets=lines(p/'packets.ndjson');scopes=lines(p/'scopes.ndjson')
    assert report['fileHash']=='b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12'
    out={'sha256':report['fileHash'],'viewport':report['viewport'],'segments':{},
         'openToFirstThumbnailMs':min(r[0] for r in frames['thumbnailReceipts'])-report['open'],
         'openToFiveNamedPreviewsMs':report['thumbnails']-report['open'],
         'decodedMaterialIds':len({r[1] for r in frames['thumbnailReceipts']}),
         'materialClicks':report['materialClicks']}
    for s in report['segments']:
        last=max([r[0] for r in frames['inputs'] if s['begin']<=r[0]<=s['up']] or [s['up']])
        tiles=[e for e in events if s['begin']<=e['at']<=s['end']]
        active=[t for t in tiles if t.get('cached')==0]
        compiles=[v for v in packets if s['begin']<=v['at']<=s['end'] and v['method']=='compile_gpu_packet']
        scoped=[v for v in scopes if s['begin']<=v['t']<=s['end'] and v.get('status')=='ok']
        out['segments'][s['name']]=dict(ready=s.get('ready'),visible=len(s['visible']),camera=s['endView'],
            afterGestureMs=s['end']-s['up'],afterLastInputMs=s['end']-last,uncachedTileRecords=len(active),
            packetBytes=sum(v.get('packetBytes',0) for v in compiles),compiles=len(compiles),
            sceneScopes=[dict(nodes=v['nodes'],keys=v['keys']) for v in scoped],
            texturePeak=max([e.get('peakTextureBytes',0) for e in tiles]+[0]),
            work={k:sum(e.get(k,0) or 0 for e in active) for k in ['compileMs','graphMs','checkpointMs',
                'finishMs','graphNonCheckpointElapsedMs','encodedPassPixels','tileDrawCalls','densePaintBatches','densePaintEffects']})
    if report.get('regional'):
        s=next(s for s in report['segments'] if s['name']=='dense-cold-view')
        out['focusAfterGestureMs']=report['regional']['at']-s['up']
    return out

daily={k:measure(work/k) for k in ['desktop-1-A','desktop-2-B','desktop-3-B','desktop-4-A']}
summary={}
for label in ['zoom-to-neighbours','dense-cold-view','dense-more-detail','dense-pan','dense-pan-back','dense-zoom-back','dense-inflight-return']:
    summary[label]={}
    for arm in 'AB':
        rows=[v['segments'][label] for k,v in daily.items() if k.endswith(arm)]
        assert all(r['ready'] for r in rows)
        summary[label][arm]={k:median([v[k] for v in rows]) for k in
            ['afterGestureMs','afterLastInputMs','texturePeak','visible','uncachedTileRecords']}
        summary[label][arm]['sumTileWorkMedians']={k:median([v['work'][k] for v in rows]) for k in rows[0]['work']}
files=['dense-settled-native','dense-shifted-native','dense-return-native']
fixed=read(work/'fixed-pixels.json')
assert all(fixed[k]['changed']==0 for k in files)
device=read(work/'device-final.json')
assert len(device)==6 and all(row['diff']==0 for row in device)
assert all(not v['pairs'] for row in device for v in row['arms'][0]['samples'])
assert all(any(v['pairs']>0 for v in row['arms'][1]['samples']) for row in device)
result=dict(primary=daily,medians=summary,
    highZoom={a:measure(work/('high-'+a)) for a in 'AB'},
    focusQa={a:measure(work/n).get('focusAfterGestureMs') for a,n in [('A','topology-oracle'),('B','topology-oracle-B')]},
    fixedScope={a:[v for v in lines(work/('fixed-'+a)/'scopes.ndjson') if v.get('status')=='ok'] for a in 'AB'},
    freeGesturePixelControl=read(work/'topology-pixels.json'),sameCameraSameScopePixels=fixed,
    hardware={m:{a:sum(median([s[m] for s in row['arms'][i]['samples']]) for row in device)
                  for i,a in enumerate('AB')} for m in ['complete','draws','passes','pairs']})
dest.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
