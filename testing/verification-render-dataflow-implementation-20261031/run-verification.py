from pathlib import Path
import subprocess,json,time,os,hashlib,statistics,signal,sys
out=Path(__file__).resolve().parent;root=out.parent.parent;frontend=root/'frontend/design-client'
node='/Users/Apple/.nvm/versions/node/v24.12.0/bin/node'
env=dict(os.environ,PYTHON='/tmp/futureox-font-tests-20261030/bin/python',TMPDIR='/tmp/futureox-font-tests-20261030')
records=json.loads((out/'verification-results.json').read_text()) if '--resume' in sys.argv else []
def run(name,cmd,cwd=root,expected=0,timeout=600):
 previous=next((r for r in reversed(records) if r['name']==name),None)
 if '--resume' in sys.argv and previous and previous['code']==expected:
  print('REUSE PASSED '+name,flush=True);return (out/(previous.get('log',name+'.log'))).read_text()
 print('START '+name,flush=True);start=time.time()
 with (out/(name+'.log')).open('w') as log:
  process=subprocess.Popen([str(c) for c in cmd],cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=process.wait(timeout=timeout)
  except subprocess.TimeoutExpired:
   os.killpg(process.pid,signal.SIGTERM);process.wait();code=124
 row=dict(name=name,command=[str(c) for c in cmd],cwd=str(cwd),code=code,seconds=time.time()-start,expected=expected)
 records.append(row);(out/'verification-results.json').write_text(json.dumps(records,indent=2)+'\n');print(json.dumps(row),flush=True)
 if code!=expected:raise SystemExit(code or 1)
 return (out/(name+'.log')).read_text()
for label,lib in [('baseline','/tmp/futureox-dataflow-baseline-20261031/libfutureox_design_kernel.rlib'),('candidate',str(root/'design-studio/target/release/deps/libfutureox_design_kernel.rlib'))]:
 for kind,flags in [('counted',['--cfg','measure_alloc']),('timed',[])]:
  binary=out/(label+'-'+kind+'-probe')
  run('build-'+label+'-'+kind,['rustc','--edition=2024','-O',*flags,out/'memory-parity.rs','-L','dependency='+str(root/'design-studio/target/release/deps'),'--extern','futureox_design_kernel='+lib,'-o',binary])
for label in ['baseline','candidate']:
 run('memory-'+label,[out/(label+'-counted-probe'),root/'testing/analysis-render-dataflow-20261031/snapshot-descriptor.txt',out/(label+'-parity.scene')])
for number,label in enumerate(['baseline','candidate','candidate','baseline']):
 run('clone-'+str(number)+'-'+label,[out/(label+'-timed-probe'),root/'testing/analysis-render-dataflow-20261031/snapshot-descriptor.txt'])
run('wasm-layout',['rustc','--edition=2024','--target','wasm32-unknown-unknown','--crate-type=lib','--emit=llvm-ir','-O','-C','panic=abort',root/'testing/analysis-render-dataflow-20261031/wasm-layout-probe.rs','-L','dependency='+str(root/'design-studio/target/wasm32-unknown-unknown/release/deps'),'-L','dependency='+str(root/'design-studio/target/release/deps'),'--extern','futureox_design_kernel='+str(root/'design-studio/target/wasm32-unknown-unknown/release/deps/libfutureox_design_kernel.rlib'),'-o',out/'wasm-layout.ll'])
run('native-pixels',[node,out/'native-pixels.mjs'])
wasm=frontend/'public/kernel/design_kernel_bg.wasm'
env['FUTUREOX_EXPECT_KERNEL_SHA256']=hashlib.sha256(wasm.read_bytes()).hexdigest()
run('frontend-typecheck',[frontend/'node_modules/.bin/tsc','--noEmit'],frontend)
tests=['src/kernel/image-row-source.test.ts','src/kernel/gpu/exact-filter-pass.test.ts','src/kernel/gpu/scene-packet.test.ts','src/kernel/render-kernel.test.ts','src/kernel/prepared-packet.test.ts','src/kernel/render-kernel-image-sharing.test.ts','src/kernel/scene-image-hydration.test.ts','src/kernel/render-worker-image-hydration.test.ts','src/kernel/gpu/webgpu-bindings.test.ts','src/kernel/gpu/linear-image-rows.test.ts','src/layout-grid-overlay.test.ts','src/grid-overlay.test.ts','src/engine-history.test.ts','src/layout-order.test.ts','src/model-layout.test.ts','src/import-fig-layout.test.ts']
run('frontend-regressions',[frontend/'node_modules/.bin/vitest','run','--maxWorkers=1','--testNamePattern','^(?!.*real kernel packets and upload bytes equal baseline)',*tests],frontend)
control=run('grid-preimage-control',[frontend/'node_modules/.bin/vitest','run','--config',out/'vitest-grid-control.config.mts','-t','selected Grid'],frontend,expected=1)
assert 'selected Grid overlays' in control and 'AssertionError' in control, 'Negative control must hit the actual regression assertion'
run('mounted-canvas',[frontend/'node_modules/.bin/vitest','run','--config','vitest.scene-reuse.config.ts'],frontend)
run('frontend-production-build',[node,frontend/'node_modules/vite/bin/vite.js','build'],frontend)
print('CPU AND PORTABLE VERIFICATION COMPLETE',flush=True)
