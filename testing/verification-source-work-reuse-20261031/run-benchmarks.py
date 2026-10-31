from pathlib import Path
import subprocess, json, hashlib, statistics

out = Path(__file__).resolve().parent
repo = out.parent.parent
node = '/Users/Apple/.nvm/versions/node/v24.12.0/bin/node'
for name in ['candidate-1', 'baseline-2', 'candidate-2']:
    command = [node, str(out/'startup-ab.mjs'), str(out/(name.split('-')[0]+'-bin')), str(out/name)]
    with (out/(name+'.log')).open('w') as log:
        run = subprocess.run(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT)
    if run.returncode: raise SystemExit(run.returncode)
    data = json.loads((out/name/'manifest.json').read_text())
    assert data['status']=='passed' and data['sourceUnchanged']
    print(json.dumps({'run':name,'stages':data['stages'],'snapshotHash':data['snapshotHash']}),flush=True)

runs = {name:json.loads((out/name/'manifest.json').read_text()) for name in ['baseline-1','candidate-1','baseline-2','candidate-2']}
assert len({data['sourceHash'] for data in runs.values()})==1
assert len({data['snapshotHash'] for data in runs.values()})==1, 'full snapshot bytes changed'
reference = json.loads((out/'baseline-1/snapshot.json').read_text())
reference_layout = json.loads((out/'baseline-1/layout.json').read_text())
for name in runs:
    descriptor = json.loads((out/name/'snapshot.json').read_text())
    assert {k:v for k,v in descriptor.items() if k!='path'} == {k:v for k,v in reference.items() if k!='path'}
    assert json.loads((out/name/'layout.json').read_text()) == reference_layout
    with open(reference['path'],'rb') as a, open(descriptor['path'],'rb') as b:
        while True:
            block = a.read(1024*1024)
            assert b.read(1024*1024)==block, name
            if not block:break
metrics=[]
for stage in [s['stage'] for s in runs['baseline-1']['stages']]:
    before=[next(s['ms'] for s in runs[f'baseline-{i}']['stages'] if s['stage']==stage) for i in [1,2]]
    after=[next(s['ms'] for s in runs[f'candidate-{i}']['stages'] if s['stage']==stage) for i in [1,2]]
    metrics.append({'stage':stage,'baseline_ms':before,'candidate_ms':after,'baseline_mean_ms':statistics.mean(before),
                    'candidate_mean_ms':statistics.mean(after),'change_percent':(statistics.mean(after)/statistics.mean(before)-1)*100})
result={'scope':'native production startup wall time; process fresh, OS file cache not cold; two paired runs, no profiler',
        'full_snapshot_byte_equal':True,'snapshot_sha256':runs['baseline-1']['snapshotHash'],'metrics':metrics}
(out/'startup-results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
