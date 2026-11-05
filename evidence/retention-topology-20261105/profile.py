"""macOS: python3 profile.py OUTPUT ORIGINAL_BENCH_DIRECTORY C_BINARY FONT.
Use fresh OUTPUT. The interposer is injected only into the named benchmark.
"""
import json,os,subprocess,sys
from pathlib import Path

out,old,candidate,font=[Path(p).resolve() for p in sys.argv[1:5]]
out.mkdir()
here=Path(__file__).resolve().parent
library=out/'heapwatch.dylib'
subprocess.run(['clang','-O2','-dynamiclib',here/'heapwatch.c','-o',library],check=True)
binaries={'A':old/'A','B':old/'B','C':candidate}
def capture(arm,label,mark=None):
    exe=binaries[arm];trace=out/(label+'.trace')
    env={**os.environ,'DYLD_INSERT_LIBRARIES':str(library),'RETENTION_TRACE':str(trace),
         'RETENTION_MIN':'4096','RETENTION_EXE':exe.name}
    if mark:
        assert len(mark['tile'])==len(mark['frame'])==1
        env.update(RETENTION_TILE_STACK=str(mark['tile'][0]),RETENTION_FRAME_STACK=str(mark['frame'][0]))
    with (out/(label+'.frames')).open('w') as f:
        subprocess.run([exe,'measure',old/'117.json',old/'117-overview-1024.json',font],env=env,stdout=f,check=True)
    report=out/(label+'.owners.json')
    subprocess.run([sys.executable,here/'stacks.py',trace,exe,report],check=True)
    return json.loads(report.read_text())['landmarkStacks']
marks={arm:capture(arm,arm+'-sites') for arm in 'ABC'}
for arm in 'BAC':
    label=arm+'-marked'
    capture(arm,label,marks[arm])
    subprocess.run([sys.executable,here/'pages.py',out/(label+'.trace'),binaries[arm],out/(label+'.pages.json')],check=True)
