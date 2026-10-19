#!/usr/bin/env python3
"""Run actual mounted Canvas CPU traces against exact shipped baseline and candidate.
No build, installation, browser, GPU, network, or socket is started.
"""
import hashlib, json, os, pathlib, platform, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
CLIENT = ROOT / 'frontend/design-client'
OUT = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parent/'abba'
OUT.mkdir(parents=True,exist_ok=False)
NODE = os.environ.get('NODE','node')
FILES = ['frontend/design-client/src/Canvas.tsx','frontend/design-client/src/canvas-scene-snapshots.ts','frontend/design-client/src/kernel/picking.ts','frontend/design-client/src/geometry.ts','frontend/design-client/src/engine.ts','frontend/design-client/src/CanvasScrollbars.tsx','frontend/design-client/src/ruler-guides.ts','frontend/design-client/src/canvas-scene-reuse-cpu.test.tsx','frontend/design-client/vitest.scene-reuse.config.ts','testing/verification-canvas-scene-reuse-20261019/baseline/Canvas.tsx','frontend/design-client/public/kernel/design_kernel_bg.wasm']
def hashes():return {p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in FILES}
manifest={'runtime':platform.platform(),'node':subprocess.check_output([NODE,'--version'],text=True).strip(),'before':hashes(),'runs':[],'measurement':'50 real Editor.preview publications and mounted React Canvas CPU updates; render-device/host boundaries are mocked. Work counts are primary; elapsed CPU trace totals are not GPU/FPS or input-to-display latency.'}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for label,baseline in [('baseline-a',True),('candidate-a',False),('candidate-b',False),('baseline-b',True)]:
 env=os.environ.copy();env['CANVAS_SCENE_BASELINE']='1' if baseline else '0';env['CANVAS_SCENE_METRICS']=str(OUT/(label+'.jsonl'))
 cmd=[NODE,'node_modules/vitest/vitest.mjs','run','--config','vitest.scene-reuse.config.ts','--reporter=json','--outputFile='+str(OUT/(label+'.vitest.json'))]
 started=time.time()
 with (OUT/(label+'.log')).open('w') as log:result=subprocess.run(cmd,cwd=CLIENT,env=env,stdout=log,stderr=subprocess.STDOUT)
 report=json.loads((OUT/(label+'.vitest.json')).read_text()) if (OUT/(label+'.vitest.json')).exists() else {}
 ok=result.returncode==0 and report.get('success') and report.get('numTotalTests')==9 and report.get('numPassedTests')==9 and report.get('numPendingTests')==0
 manifest['runs'].append({'label':label,'baseline':baseline,'command':cmd,'startedEpochSeconds':started,'processSeconds':time.time()-started,'exitCode':result.returncode,'testsPassed':report.get('numPassedTests'),'ok':bool(ok)})
 (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(label,'PASS' if ok else 'FAIL',flush=True)
 if not ok:sys.exit(1)
manifest['after']=hashes();manifest['inputsUnchanged']=manifest['before']==manifest['after']
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if not manifest['inputsUnchanged']:raise RuntimeError('Inputs changed during ABBA')
rows={label:[json.loads(line) for line in (OUT/(label+'.jsonl')).read_text().splitlines()] for label in [r['label'] for r in manifest['runs']]}
summary=[]
for reference in rows['baseline-a']:
 matches={label:next(row for row in records if row['kind']==reference['kind'] and row.get('shape')==reference.get('shape') and row.get('nodes')==reference.get('nodes')) for label,records in rows.items()}
 if reference['kind']=='fixed-displayed-preview':
  exact=['finalDocumentHash','finalEntriesHash','baselineSnapshotHash']
  for key in exact:
   if len({row[key] for row in matches.values()})!=1:raise AssertionError((key,matches))
  old=[matches[label]['durationMs'] for label in ['baseline-a','baseline-b']];new=[matches[label]['durationMs'] for label in ['candidate-a','candidate-b']]
  summary.append({'kind':reference['kind'],'shape':reference['shape'],'nodes':reference['nodes'],'samples':50,'baselineMs':old,'candidateMs':new,'meanReductionPercent':100*(1-sum(new)/sum(old)),'sceneBuilds':{'baseline':reference['scenes'],'candidate':matches['candidate-a']['scenes']},'indexBuilds':{'baseline':reference['indexes'],'candidate':matches['candidate-a']['indexes']},'nodeVisits':{'baseline':reference['nodeVisits'],'candidate':matches['candidate-a']['nodeVisits']},'cells':{'baseline':reference['cells'],'candidate':matches['candidate-a']['cells']},'cellReferences':{'baseline':reference['cellReferences'],'candidate':matches['candidate-a']['cellReferences']},'largeEntries':{'baseline':reference['largeEntries'],'candidate':matches['candidate-a']['largeEntries']},'exactFinalHashes':{k:reference[k] for k in exact}})
 else:
  expected={k:v for k,v in reference.items() if k!='baseline'}
  for row in matches.values():
   if {k:v for k,v in row.items() if k!='baseline'}!=expected:raise AssertionError(('checkpoint mismatch',matches))
  summary.append({'kind':reference['kind'],'exactAcrossAllRuns':True})
(OUT/'summary.json').write_text(json.dumps({'inputsUnchanged':True,'comparisons':summary},indent=2)+'\n')
print('All final documents, complete scene hashes, history/page checkpoints and local shape release results match.',flush=True)
