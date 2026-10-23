"""Read captured diagnostic logs only; no application or source-file mutations."""
import collections, datetime, hashlib, json, math, pathlib, sys
OUT = pathlib.Path(__file__).resolve().parent
TZ = datetime.timezone(datetime.timedelta(hours=8))
def timefmt(ms): return datetime.datetime.fromtimestamp(ms/1000,TZ).isoformat()
def stats(values):
    v=sorted(values)
    return dict(n=len(v),sum=round(sum(v),3),median=round(v[len(v)//2],3),p95=round(v[math.ceil(len(v)*.95)-1],3),max=round(v[-1],3)) if v else dict(n=0)
def slim(r): return {k:v for k,v in r.items() if not k.startswith('producer') and k not in ['v','failureDictionarySha256','diagnosticProducerVersion','failureDictionaryVersion']}
def analyze(path):
    data=path.read_bytes(); complete=data[:data.rfind(b'\n')+1]; records=[]; bad=[]
    for line_no,line in enumerate(complete.decode(errors='replace').splitlines(),1):
        if '[render-diag] ' not in line: continue
        try:
            row=json.loads(line.split('[render-diag] ',1)[1])
            for r in row.get('batch',[row]):
                r['_line']=line_no
                if 'at' in r:r['_time']=timefmt(r['at'])
                records.append(r)
        except Exception:bad.append(line_no)
    groups=collections.defaultdict(list)
    for r in records:groups[r.get('event')].append(r)
    metric={}
    for event,fields in {'compile':['durationMs'],'hydrate':['durationMs'],'tile':['compileMs','graphMs','finishMs','checkpointMs','renderMs','pipelineWallMs','preparationWaitMs','peakTextureBytes','workingTextureBytes','packetNodeVisits','encodedPassPixels','drawCalls'], 'result':['compileMs','graphMs','finishMs','renderMs','pipelineWallMs','preparationWaitMs'], 'queue-start':['waitMs','queueDepth'], 'queue-end':['durationMs'],'frame-window':['uiIntervalMaxMs','inputPresentMaxMs','pendingInputAgeMs'], 'viewport-state':['oldContentAgeMs','coverage','sharpCoverage','nativePhaseCoverage']}.items():
        metric[event]={f:stats([r[f] for r in groups[event] if f in r]) for f in fields}
    stages={}
    for event,code,phase,field in [('cpu-stage','cpuStageCode','cpuPhase','cpuDurationMs'),('load-stage','methodCode','phase','durationMs'),('preparation','methodCode','phase','durationMs')]:
        codes=sorted({r[code] for r in groups[event] if code in r})
        stages[event]={str(c):stats([r[field] for r in groups[event] if r.get(code)==c and r.get(phase)==(4 if event=='preparation' else 2) and field in r]) for c in codes}
    cpu_slow=[slim(r) for r in groups['cpu-stage'] if r.get('cpuDurationMs',0)>=50]
    stalls=[slim(r) for r in groups['frame-window'] if r.get('uiStalls',0)>0]
    failure=[slim(r) for r in records if r.get('event') in ['error','failure-summary','failure-origin']]
    identities=[]
    for r in records:
        identity={k:v for k,v in r.items() if k.startswith('producer') or k.startswith('failureDictionary')}
        if identity and identity not in identities:identities.append(identity)
    boundaries=collections.defaultdict(list)
    for r in groups['preparation']:
        if 'boundaryDurationMs' in r:boundaries[str((r.get('methodCode'),r.get('boundaryCode')))].append(r['boundaryDurationMs'])
    tops={}
    for event,field in [('tile','renderMs'),('result','pipelineWallMs'),('compile','durationMs'),('preparation','boundaryDurationMs'),('load-stage','durationMs'),('frame-window','inputPresentMaxMs'),('viewport-state','oldContentAgeMs')]:
        tops[event]=[slim(r) for r in sorted(groups[event],key=lambda r:r.get(field,0),reverse=True)[:12]]
    result=dict(file=str(path),capturedAt=datetime.datetime.now(TZ).isoformat(),snapshotBytes=len(complete),snapshotSha256=hashlib.sha256(complete).hexdigest(),partialTailBytes=len(data)-len(complete),badLines=bad,records=len(records),period=[timefmt(min(r['at'] for r in records)),timefmt(max(r['at'] for r in records))],events={k:len(v) for k,v in groups.items()},identities=identities,metrics=metric,stages=stages,boundaries={k:stats(v) for k,v in boundaries.items()},cpuSlow=cpu_slow,stalls=stalls,failures=failure,top=tops,runtime=[slim(r) for r in groups['runtime-config']],actions=[slim(r) for r in groups['canvas-action']],operations=[slim(r) for r in groups['operation']],pose=[slim(r) for r in groups['pose-lifecycle']],summary=[slim(r) for r in groups['summary']])
    (OUT/(path.stem+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    return result
if __name__=='__main__':
    for arg in sys.argv[1:]:
        r=analyze(pathlib.Path(arg));print(json.dumps({k:r[k] for k in ['file','records','period','metrics','stages']},ensure_ascii=False))
