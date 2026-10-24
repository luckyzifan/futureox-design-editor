import json,hashlib,sys
from pathlib import Path
out=Path('testing/verification-fig-import-20261024')
for run in sys.argv[1:]:
 d=json.loads((out/(run+'.json')).read_text());rows=[];seen=set()
 for line in (out/run/'host-stdout.log').open():
  if '[render-diag] ' not in line:continue
  try:batch=json.loads(line.split('[render-diag] ',1)[1])
  except:continue
  for r in batch.get('batch',[batch]):
   key=(r.get('source'),r.get('session'),r.get('seq'))
   if key in seen:continue
   seen.add(key)
   if d['motionStart']<=r.get('at',0)<=d['motionEnd']:rows.append(r)
 s=[r for r in rows if r.get('event')=='camera-submit' and r.get('coverageMeasured')==1]
 costs=[r for r in rows if r.get('encodedPassPixels') and r.get('outputPixelVisits')]
 result={'run':run,'scope':'Matched source and deterministic input; CPU sampler off; compositor telemetry only, no scanout or full G2/G5 acceptance','motionMs':d['motionEnd']-d['motionStart'],'actions':len(d['actions']),'uiStalls':len(d['metrics']['stalls']),'uiIntervalMaxMs':d['metrics']['max'],'cameraSubmits':len(s),'minCoverage':min((r.get('coverage',1)for r in s),default=None),'maxUpscale':max((r.get('maxUpscale',0)for r in s),default=0),'nonSharpSubmits':sum(r.get('sharpCoverage',1)<1 for r in s),'nonNativePhaseSubmits':sum(r.get('nativePhaseCoverage',1)<1 for r in s),'surfaceRejectedRecords':sum(r.get('surfaceRejected',0)for r in rows),'nonCancellationErrors':[r for r in rows if r.get('event')=='error' and not (r.get('failureCategory')==1 and r.get('failureCode')==1)],'maxPipelineMs':max((r.get('pipelineWallMs',0)for r in rows),default=0),'maxPassAmplification':max((r['encodedPassPixels']/r['outputPixelVisits']for r in costs),default=0),'maxRendererWorkingBytes':max((r.get('workingTextureBytes',0)for r in rows),default=0),'documentRevisions':sorted({r['documentRevision']for r in rows if 'documentRevision'in r}),'finalScreenshotSha256':hashlib.sha256((out/run/'after.png').read_bytes()).hexdigest(),'samples':[{k:r.get(k)for k in ['at','zoom','coverage','sharpCoverage','nativePhaseCoverage','maxUpscale','requestId']}for r in s]}
 (out/(run+'-quality.json')).write_text(json.dumps(result,indent=2));print({k:v for k,v in result.items()if k not in ['samples','scope','nonCancellationErrors']});print('nonCancellationErrors',len(result['nonCancellationErrors']))
