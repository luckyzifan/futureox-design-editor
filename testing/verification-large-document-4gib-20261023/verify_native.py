import pathlib,json,subprocess,os,time,hashlib,re,signal,sys
import argparse
parser=argparse.ArgumentParser(description='Run the frozen native large-document acceptance sequentially, without other heavy work.')
parser.add_argument('--sketch',type=pathlib.Path,required=True)
parser.add_argument('--only')
parser.add_argument('--report',default='native-large-results.json')
args=parser.parse_args()
assert pathlib.Path(args.report).name==args.report
repo=pathlib.Path(__file__).resolve().parents[2]
out=pathlib.Path(__file__).resolve().parent
artifacts=[]
for line in (out/'native-build.jsonl').read_text().splitlines():
 try:item=json.loads(line)
 except:continue
 if item.get('reason')=='compiler-artifact' and item.get('executable') and item.get('target',{}).get('name')=='futureox_design_desktop_backend':artifacts.append(item)
assert artifacts,'Native test executable missing'
executable=pathlib.Path(artifacts[-1]['executable']);sha=hashlib.sha256(executable.read_bytes()).hexdigest()
plan=json.loads((out/'acceptance-plan.json').read_text());results=[]
if args.only:
 plan['tests']=[test for test in plan['tests'] if test['name']==args.only]
 assert plan['tests'], 'Unknown frozen gate'
source_files=[repo/'design-studio/crates/design-kernel/src/large_json.rs',repo/'design-studio/crates/design-desktop-backend/src/large_document.rs',*sorted((repo/'design-studio/crates/design-desktop-backend/src/large_document').glob('*.rs'))]
inputs={str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}
env=dict(os.environ,CORE_LARGE_SKETCH_INPUT=str(args.sketch.resolve()),RUST_MIN_STACK='8388608')
for spec in plan['tests']:
 name=spec['name'];command=['/usr/bin/time','-l',str(executable),'large_document::tests::'+name,'--exact','--ignored','--nocapture','--test-threads=1']
 print('START',name,flush=True);started=time.monotonic();log=out/(name+'.log')
 with log.open('w')as stream:
  process=subprocess.Popen(command,cwd=repo,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=process.wait(timeout=600)
  except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=15);code=124
 text=log.read_text(errors='replace');match=re.search(r'(\d+)\s+maximum resident set size',text);rss=int(match.group(1))if match else None
 unchanged=all(hashlib.sha256(p.read_bytes()).hexdigest()==inputs[str(p.relative_to(repo))] for p in source_files)
 result={'gate':name,'exit':code,'seconds':round(time.monotonic()-started,3),'nativePeakRssBytes':rss,'rssLimitBytes':spec['nativeProcessPeakRssLimitBytes'],'withinRssLimit':rss is not None and rss<=spec['nativeProcessPeakRssLimitBytes'],'testedExecutableSha256':sha,'log':log.name,'sourceUnchangedDuringRun':unchanged}
 results.append(result);(out/args.report).write_text(json.dumps({'profile':'desktop-dev','memoryScope':'isolated native test process; excludes Electron and filesystem cache','sourceHashes':inputs,'results':results},indent=2)+'\n')
 print('END',json.dumps(result),flush=True);print('\n'.join(text.splitlines()[-22:]),flush=True)
 if code or not result['withinRssLimit'] or not unchanged:sys.exit(1)
