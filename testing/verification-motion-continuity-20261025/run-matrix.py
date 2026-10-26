#!/usr/bin/env python3
"""Serial real-file probes. Each child owns a fresh profile; originals are read-only."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time

root=Path(__file__).resolve().parents[2]
out=Path(__file__).resolve().parent
runtime=json.loads((out/'runtime.json').read_text())
host=str(Path(runtime['runtime'])/sys.argv[1])
prefix=sys.argv[2]
kinds=sys.argv[3:] or ['117','fig','sketch']
rows=[]
for kind in kinds:
    for tool in ['v','h','zoom']:
        name=f'{prefix}-{kind}-{tool}'
        env=dict(os.environ,DRAG_HOST=host,FIG_HOST=host,CAPTURE_DRAG_MOTION='1',CAPTURE_MOTION='1',DRAG_ONLY_PAN='1',
                 MOTION_TOOL=tool,MOTION_ZOOM='100',MOTION_STEPS='24',MOTION_DX='360',MOTION_DY='160',MOTION_INTERVAL='8',MOTION_CONTINUOUS='1',SOURCE_CASE='1:5')
        script='capture-workbench.mjs' if tool=='zoom' else 'stress-drag.mjs'
        command=['node',str(out/script),kind,name]
        print('START',name,flush=True);start=time.time()
        with (out/(name+'.log')).open('w') as log:
            try:
                child=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=420)
                code=child.returncode
            except subprocess.TimeoutExpired:
                # The child harness normally closes its owned app in finally.
                # Do not kill unrelated processes or treat timeout as a pass.
                code=124
        row={'name':name,'command':command,'exit_code':code,'seconds':time.time()-start}
        if (out/name/'report.json').exists():
            summary=subprocess.run(['node',str(out/'summarize.mjs'),str(out/name)],cwd=root,capture_output=True,text=True)
            row['summaryExit']=summary.returncode
            if summary.returncode==0:row['quality']=json.loads(summary.stdout)
        rows.append(row)
        (out/(prefix+'-matrix.json')).write_text(json.dumps(rows,indent=2)+'\n')
        print('END',name,code,row.get('quality',{}).get('motionGate'),flush=True)
for fixture in runtime['fixtures']:
    assert hashlib.sha256(Path(fixture['file']).read_bytes()).hexdigest()==fixture['sha256'], 'Original input changed'
print('Original fixture hashes unchanged',flush=True)
