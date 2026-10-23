from pathlib import Path
import argparse,hashlib,json,os,signal,subprocess,time,shutil
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--private-117',type=Path,required=True);p.add_argument('--wasm-sha256',required=True);p.add_argument('--only');p.add_argument('--run-id',default='combination-r2');a=p.parse_args()
R=Path(__file__).resolve().parent.parent;S=a.repo.resolve();C=S/'frontend/design-client';V=R/'validation'/a.run_id;V.mkdir(parents=True,exist_ok=True);T=V/'tmp';T.mkdir(exist_ok=True);sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert a.wasm_sha256!='e7940afed3992ac586e34d3fc2816e23c77265992645524c0ef20e001b953613','Do not certify Rust policy with old WASM'
assert sha(a.private_117)=='7adbf4fafb41a6198a8ff7a10c672f6e06aeecef991d6a312ef1830ee8a300cc'
assert sha(C/'public/kernel/design_kernel_bg.wasm')==a.wasm_sha256
manifest=json.loads((R/'manifest.json').read_text());expected={x['path']:x['sha256'] for x in manifest['changes']+manifest['requirements']};assert all(sha(S/k)==v for k,v in expected.items())
P=json.loads((R/'verification/gate-plan.json').read_text());node=['node','--max-old-space-size=384'];vitest=node+['node_modules/vitest/vitest.mjs','run']
commands=[('typecheck',node+['node_modules/typescript/bin/tsc','--noEmit'],C),('client-joint',vitest+P['frontTests']+['--maxWorkers=1','--no-file-parallelism'],C)]
for name,config in [('zoom-portable','vitest.zoom-refinement.config.mts'),('overlay-focused','vitest.release-overlay.config.mts'),('overlay-mounted','vitest.overlay-mounted.config.mts'),('overlay-chain','vitest.overlay-chain.config.mts')]:commands.append((name,vitest+['--config',config,'--maxWorkers=1','--no-file-parallelism'],C))
commands.append(('ownership-node',node+['--experimental-transform-types','--import','./scripts/node-ts-local-resolver.mjs','--test','src/import-ownership.test.mjs'],C))
commands.append(('desktop-node',node+['--test','--test-concurrency=1']+['frontend/design-desktop/test/'+x+'.test.mjs' for x in ['notice-runtime-versions','production-assets','render-producer-identity','render-runtime-wasm-identity','render-terminal-diagnostics']],S))
commands.append(('web-build',node+['node_modules/vite/bin/vite.js','build','--outDir',str(V/'web-output')],C))
if a.only:commands=[v for v in commands if v[0]==a.only];assert commands
assert not (V/'RUNNING.json').exists()
env={**os.environ,'TMPDIR':str(T),'NODE_OPTIONS':'--max-old-space-size=384','NODE_DISABLE_COMPILE_CACHE':'1','CORE_NAVIGATION_117_INPUT':str(a.private_117.resolve()),'CORE_ROTATION_117_INPUT':str(a.private_117.resolve()),'FUTUREOX_EXPECT_KERNEL_SHA256':a.wasm_sha256}
(V/'RUNNING.json').write_text(json.dumps({'pid':os.getpid(),'time':time.time()}));results=[]
try:
 for name,cmd,cwd in commands:
  assert not (V/(name+'.log')).exists(),'Preserve previous run; choose explicit new revision directory'
  if (R/'STOP_BEFORE_NEXT_GATE').exists():print('PAUSED_AT_GATE_BOUNDARY '+name,flush=True);break
  minimum={str(q):shutil.disk_usage(q).free for q in [V,Path('/tmp')]};assert min(minimum.values())>=400*2**20
  if name=='web-build':assert min(minimum.values())>=500*2**20,'Need100MiB build reserve'
  peak=0;start=time.monotonic();stop=None;local={**env}
  if name=='overlay-chain':local['OVERLAY_CHAIN_TRACE']=str(V/'overlay-chain-trace.json')
  if name=='overlay-focused':local['OVERLAY_WORK_COUNTS']=str(V/'overlay-work-counts.jsonl')
  with (V/(name+'.log')).open('w') as log:
   proc=subprocess.Popen(cmd,cwd=cwd,env=local,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   while proc.poll() is None:
    rss=0
    for f in Path('/proc').glob('[0-9]*/stat'):
     try:
      fields=f.read_text().rsplit(')',1)[1].split()
      if int(fields[2])==proc.pid:rss+=int((f.parent/'statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
     except (OSError,ValueError,IndexError):pass
    peak=max(peak,rss)
    for x in minimum:minimum[x]=min(minimum[x],shutil.disk_usage(x).free)
    if peak>1536*2**20:stop='RSS>1536MiB'
    elif min(minimum.values())<400*2**20:stop='disk<400MiB'
    elif time.monotonic()-start>300:stop='timeout>300s'
    if stop:os.killpg(proc.pid,signal.SIGTERM);break
    time.sleep(.05)
   try:code=proc.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
  record={'gate':name,'command':cmd,'cwd':str(cwd),'exit':code,'stop':stop,'peakProcessGroupRSSBytes':peak,'minimumFreeBytes':minimum,'seconds':time.monotonic()-start,'logSHA256':sha(V/(name+'.log'))};results.append(record);(V/(name+'-guard.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record),flush=True)
  if code or stop:raise RuntimeError(name+' failed')
 assert all(sha(S/k)==v for k,v in expected.items());print('REQUESTED_GATES_TERMINAL',flush=True)
finally:
 (V/('results-'+str(int(time.time()))+'.json')).write_text(json.dumps(results,indent=2)+'\n');(V/'RUNNING.json').rename(V/('TERMINAL-'+str(int(time.time()))+'.json'))
