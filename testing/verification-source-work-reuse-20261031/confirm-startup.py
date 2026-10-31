from pathlib import Path
import subprocess,json,time,threading,os,shutil,statistics,sys

out=Path(__file__).resolve().parent; repo=out.parent.parent
node='/Users/Apple/.nvm/versions/node/v24.12.0/bin/node'
reference=json.loads((out/'baseline-1/snapshot.json').read_text())
reference_hash=json.loads((out/'baseline-1/manifest.json').read_text())['snapshotHash']
selection = sys.argv[1] if len(sys.argv)>1 else 'candidate'
assert selection in ['candidate','selected']
prefix = 'confirmation' if selection=='candidate' else 'selected-confirmation'
names = ['baseline-3','candidate-3','candidate-4','baseline-4'] if selection=='candidate' else ['baseline-5','selected-1','selected-2','baseline-6']
records=[]
for name in names:
    stop=threading.Event(); samples=[]
    def monitor():
        while not stop.is_set():
            rows=subprocess.check_output(['ps','-eo','pid,ppid,pcpu,comm'],text=True).splitlines()[1:]
            processes=[]
            for row in rows:
                p=row.split(None,3)
                if len(p)==4:processes.append((int(p[0]),int(p[1]),float(p[2]),p[3]))
            owned={os.getpid()}
            for _ in range(10):owned.update(pid for pid,parent,_,_ in processes if parent in owned)
            active=[{'pid':pid,'cpu_percent':cpu,'executable':exe} for pid,_,cpu,exe in processes
                    if pid not in owned and cpu>=25 and any(s in exe.lower() for s in ['rustc','cargo','clang','design-prepare','futureox','electron','node'])]
            samples.append({'time':time.time(),'external_active':active})
            stop.wait(2)
    thread=threading.Thread(target=monitor); thread.start()
    command=[node,str(out/'startup-ab.mjs'),str(out/(name.split('-')[0]+'-bin')),str(out/name)]
    try:
        with (out/(name+'.log')).open('w') as log:run=subprocess.run(command,cwd=repo,stdout=log,stderr=subprocess.STDOUT)
    finally:stop.set();thread.join()
    if run.returncode:raise SystemExit(run.returncode)
    data=json.loads((out/name/'manifest.json').read_text());assert data['snapshotHash']==reference_hash and data['sourceUnchanged']
    desc=json.loads((out/name/'snapshot.json').read_text());assert desc['store']==reference['store']
    with open(reference['path'],'rb') as a,open(desc['path'],'rb') as b:
        while True:
            block=a.read(1024*1024);assert b.read(1024*1024)==block
            if not block:break
    records.append({'run':name,'command':command,'exit_code':run.returncode,'stages':data['stages'],
        'full_snapshot_byte_equal':True,'load_samples':samples})
    (out/(prefix+'-runs.json')).write_text(json.dumps(records,indent=2)+'\n')
    print(json.dumps({'run':name,'stages':data['stages'],'external_busy_samples':sum(bool(s['external_active']) for s in samples)}),flush=True)
    # This run's disposable spool is recreated from the unchanged source by the command above.
    recovery=out/name/'recovery';assert recovery.is_dir() and not recovery.is_symlink();shutil.rmtree(recovery)
summary=[]
for stage in [s['stage'] for s in records[0]['stages']]:
    values={label:[next(s['ms'] for s in r['stages'] if s['stage']==stage) for r in records if r['run'].startswith('baseline' if label=='baseline' else selection)] for label in ['baseline','candidate']}
    summary.append({'stage':stage,**values,'change_percent':(statistics.mean(values['candidate'])/statistics.mean(values['baseline'])-1)*100})
(out/(prefix+'-summary.json')).write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary),flush=True)
