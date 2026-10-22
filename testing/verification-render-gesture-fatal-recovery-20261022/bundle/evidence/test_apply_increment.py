import hashlib, importlib.util, json, shutil, subprocess, tempfile
from pathlib import Path
import sys
root=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('apply_increment',root/'apply_increment.py');tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)
manifest=json.loads((root/'manifest.json').read_text());results=[]
def run_git(path,*args):return subprocess.check_output(['git','-C',str(path),*args],stderr=subprocess.STDOUT,text=True).strip()
def check_failure(action,word):
 try:action()
 except ValueError as error:assert word in str(error);return
 raise AssertionError('Expected refusal')
with tempfile.TemporaryDirectory(prefix='render-diagnostic-apply-') as td:
 base=Path(td);repo=base/'repo';repo.mkdir();bundle=base/'bundle';bundle.mkdir()
 for directory in ['source','baseline']:
  for item in manifest['changes']:
   src=root/directory/item['path']
   if src.exists():dest=bundle/directory/item['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest)
 for item in manifest['changes']:
  src=bundle/'baseline'/item['path']
  if src.exists():dest=repo/item['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest)
 run_git(repo,'init');run_git(repo,'config','user.email','fixture@example.test');run_git(repo,'config','user.name','Fixture');run_git(repo,'add','.');run_git(repo,'commit','-m','fixture baseline');head=run_git(repo,'rev-parse','HEAD')
 (bundle/'manifest.json').write_text(json.dumps(manifest))
 check_failure(lambda:tool.perform(bundle,repo,'check'),'HEAD mismatch');results.append('wrong HEAD rejected before writes')
 fixture={**manifest,'baseline':head};(bundle/'manifest.json').write_text(json.dumps(fixture))
 existing=next(item for item in manifest['changes'] if item['baselineSha256'] is not None);path=repo/existing['path'];original=path.read_bytes();path.write_bytes(b'staged user work');run_git(repo,'add','--',existing['path']);path.write_bytes(original)
 check_failure(lambda:tool.perform(bundle,repo,'check'),'staged changes');results.append('staged affected path rejected even when working bytes equal baseline')
 blob=run_git(repo,'rev-parse','HEAD:'+existing['path']);run_git(repo,'update-index','--cacheinfo','100644,'+blob+','+existing['path'])
 (repo/'unrelated-user-work.txt').write_text('keep this');run_git(repo,'add','unrelated-user-work.txt')
 assert tool.perform(bundle,repo,'check')['filesToChange']==len(manifest['changes']);results.append('all baseline hashes validated')
 assert tool.perform(bundle,repo,'apply')['filesChanged']==len(manifest['changes']);results.append('apply exact candidate hashes')
 assert tool.perform(bundle,repo,'apply')['filesChanged']==0;results.append('idempotent reapply')
 target=repo/manifest['changes'][0]['path'];wanted=target.read_bytes();target.write_bytes(b'user edits')
 check_failure(lambda:tool.perform(bundle,repo,'rollback'),'Target was modified');assert target.read_bytes()==b'user edits';results.append('rollback preserves user edits by refusal')
 target.write_bytes(wanted)
 assert tool.perform(bundle,repo,'rollback')['filesChanged']==len(manifest['changes']);results.append('rollback exact original hashes and removes only new files')
 assert tool.perform(bundle,repo,'rollback')['filesChanged']==0;results.append('idempotent rollback')
 item=manifest['changes'][-1];dest=repo/item['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(bundle/'source'/item['path'],dest)
 assert tool.perform(bundle,repo,'rollback')['filesChanged']==1;results.append('interrupted mixed baseline/candidate rollback')
 assert run_git(repo,'diff','--cached','--name-only')=='unrelated-user-work.txt';assert (repo/'unrelated-user-work.txt').read_text()=='keep this';results.append('unrelated staged work and content preserved')
 docs=repo/Path(manifest['changes'][0]['path']).parts[0];saved=base/'saved-target-parent';docs.rename(saved);outside=base/'outside';outside.mkdir();docs.symlink_to(outside,target_is_directory=True)
 check_failure(lambda:tool.perform(bundle,repo,'check'),'symlink');assert list(outside.iterdir())==[];results.append('symlink escape rejected')
 docs.unlink();saved.rename(docs)
 item=manifest['changes'][0];(bundle/'source'/item['path']).write_bytes(b'wrong bundle')
 check_failure(lambda:tool.perform(bundle,repo,'apply'),'Bundle hash mismatch');results.append('tampered bundle rejected before writes')
print(json.dumps({'passed':len(results),'failed':0,'kind':'temporary real Git fixture with fixture HEAD in test-only manifest; not applied to user checkout','checks':results},indent=2))
