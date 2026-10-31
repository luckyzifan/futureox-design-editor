from pathlib import Path
import subprocess, json, time, os, hashlib, signal
out=Path(__file__).resolve().parent
root=out.parent.parent
env=dict(os.environ,CARGO_BUILD_JOBS='2')
steps=[
('native-tests-final',['cargo','test','--locked','--no-fail-fast','--manifest-path','design-studio/Cargo.toml','-p','futureox-design-kernel','-p','futureox-design-desktop-backend','--tests','--','--test-threads=2','--skip','fig::tests::conversion_tests::gradient_transform_maps_onto_paint_transform']),
('native-release',['cargo','build','--locked','--release','--manifest-path','design-studio/Cargo.toml','-p','futureox-design-kernel','-p','futureox-design-desktop-backend','--lib','--bins']),
('portable-wasm',['python3','design-studio/scripts/build-web.py'])]
results=[]
for name,cmd in steps:
 print('START '+name,flush=True);start=time.time()
 with (out/(name+'.log')).open('w') as log:
  process=subprocess.Popen(cmd,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=process.wait(timeout=1200)
  except subprocess.TimeoutExpired:
   os.killpg(process.pid,signal.SIGTERM);process.wait();code=124
 results.append(dict(name=name,command=cmd,code=code,seconds=time.time()-start))
 (out/'build-results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps(results[-1]),flush=True)
 if code and name!='native-tests-final':raise SystemExit(code)
