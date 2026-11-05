"""Compact comparable metrics for the write-up; preserve case labels and both individual GUI runs."""
from pathlib import Path
import json,statistics as st,sys
base=Path(__file__).resolve().parent
def read(name):return json.loads((base/name).read_text())
summary={}
for name,l,r in [('gpu-only','A','B'),('integrated-no-priority','A','C'),('before-scope-review','A','E'),('shipping','A','G')]:
 path=base/(name+'-desktop.json')
 if not path.exists():continue
 rows=read(path.name);out={}
 for stage in ['dense-cold-view','dense-more-detail','dense-zoom-back','dense-inflight-return','high-100','high-3200','high-pan','high-pan-return']:
  out[stage]={}
  for arm in [l,r]:
   items=[v[stage] for k,v in rows.items() if k.endswith(arm) and stage in v]
   if not items:continue
   assert all(i['ready'] for i in items)
   samples=[i['afterGestureMs'] for i in items]
   captures=[next((q for q in i['captures'] if stage!='high-3200' or abs(q.get('zoom',0)-64)<.01),{}) for i in items]
   out[stage][arm]={'ms':round(st.median(samples),2),'samples':samples,'lastInputMs':round(st.median(i['afterLastInputMs'] for i in items),2),
    'texturePeakMiB':[round(i['peakTextureBytes']/2**20,1) if i['peakTextureBytes'] else None for i in items],
    'scopeCounts':[[[s['nodes'],len(s['keys'])] for s in i['scope']] for i in items],
    'firstNativePacketMs':[q.get('wallMs') for q in captures],
    'firstNativeStartAfterGestureMs':[q.get('startAfterGestureMs') for q in captures]}
 summary[name]=out
if (base/'cpu-117.json').exists():
 out={}
 for tile,rows in read('cpu-117.json').items():
  out[tile]={}
  for arm in 'AB':
   rs=[r for r in rows if r['arm']==arm];fs=[f for r in rs for f in r['frames'][1:]]
   out[tile][arm]={'prepMs':round(st.median(x['prepMs'] for x in fs),2),'frameMs':round(st.median(x['frameMs'] for x in fs),2),'rssMiB':round(st.median(x['rss'] for x in rs)/2**20,1),'footprintMiB':round(st.median(x['footprint'] for x in rs)/2**20,1),'compositorPeakBytes':st.median(x['compositorPeakBytes'] for x in fs)}
 summary['cpu117']=out
if (base/'shipping-native.json').exists():
 rs=read('shipping-native.json');summary['native']={a:[round(st.median(r['samples'][i]['wall'] for r in rs if r['arm']==a),2) for i in range(len(rs[0]['samples']))] for a in 'AB'}
if (base/'additional-cold-desktop.json').exists() and 'shipping' in summary:
 additional=read('additional-cold-desktop.json');out={}
 for arm in 'AG':
  first=summary['shipping']['dense-cold-view'][arm]['samples']
  extra=[v['dense-cold-view']['afterGestureMs'] for k,v in additional.items() if k.endswith(arm)]
  out[arm]={'samples':[*first,*extra],'primary':first,'additional':extra,'medianMs':round(st.median([*first,*extra]),2),'rangeMs':[min([*first,*extra]),max([*first,*extra])]}
 summary['allDenseCold']=out
(base/'comparisons.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
