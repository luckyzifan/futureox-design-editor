#!/usr/bin/env python3
"""Apply only whole known states. Requires bare e411 exact baseline or whole candidate; no old ZIP chain or per-file mixing."""
import hashlib,json,os,subprocess,sys,tempfile
from pathlib import Path
STATES={'previous':('previousSha256','previousMode','previous'),'candidate':('sha256','mode','source')}
def digest(path):
    if path.is_symlink():raise ValueError('Refusing symlink: '+str(path))
    if not path.exists():return None
    if not path.is_file():raise ValueError('Refusing non-regular path: '+str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()
def safe(root,relative):
    p=Path(relative)
    if p.is_absolute() or not p.parts or any(x in ('','..','.') for x in p.parts):raise ValueError('Invalid path')
    q=root/p
    for a in (q,*q.parents):
        if a==root:break
        if a.is_symlink():raise ValueError('Refusing symlink path/parent: '+str(a))
    return q
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args])
def snapshot(root,inputs):
    out={}
    for x in inputs:
        p=safe(root,x['path']);d=digest(p);out[x['path']]=(d,p.stat().st_mode&0o777 if d is not None else None)
    return out
def classify(actual,changes):
    return [state for state,(key,mode,_) in STATES.items() if all(actual[x['path']]==(x[key],x[mode]) for x in changes)]
def atomic_write(p,data,mode):
    p.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.core-known-state-',dir=p.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.chmod(tmp,mode);os.replace(tmp,p)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
def perform(bundle,root,command):
    bundle=Path(bundle).resolve();root=Path(root).resolve(strict=True);m=json.loads((bundle/'manifest.json').read_text());changes=m['changes']; inputs=changes+m.get('requirements',[])
    if command not in ('check','apply','rollback-previous'):raise ValueError('Use check|apply|rollback-previous')
    if Path(git(root,'rev-parse','--show-toplevel').decode().strip()).resolve()!=root:raise ValueError('Target must be repository root')
    if git(root,'rev-parse','HEAD').decode().strip()!=m['baseline']:raise ValueError('HEAD mismatch; exact '+m['baseline']+' required')
    if git(root,'diff','--cached','--name-only','-z','HEAD'):raise ValueError('Staged changes are not allowed')
    allowed={x['path'] for x in inputs};dirty=set(git(root,'diff','--name-only','-z','HEAD').decode().rstrip('\0').split('\0'))-{''}
    if dirty-allowed:raise ValueError('Unrelated tracked edits exist; refusing')
    for x in changes:
        for _,(key,mode,folder) in STATES.items():
            if digest(safe(bundle/folder,x['path']))!=x[key]:raise ValueError('Bundle content mismatch: '+x['path'])
    original=snapshot(root,inputs);states=classify(original,inputs)
    if not states:raise ValueError('Not a whole known state: mixed e411/candidate bytes or unknown edits are not allowed')
    state=states[0]
    if command=='check':return {'matchedWholeStates':states,'validatedFiles':len(inputs),'baseline':m['baseline']}
    desired={'apply':'candidate','rollback-previous':'previous'}[command]
    if desired in states:return {'mode':command,'from':state,'to':desired,'filesChanged':0}
    if command.startswith('rollback') and state!='candidate':raise ValueError('Rollback requires exact candidate state, or exact already-restored target state')
    key,mode,folder=STATES[desired];pending=[]
    for x in changes:
        if original[x['path']]!=(x[key],x[mode]):
            target=safe(root,x['path']);old=target.read_bytes() if original[x['path']][0] is not None else None
            new=(bundle/folder/x['path']).read_bytes() if x[key] is not None else None
            pending.append((x,target,old,new))
    # Recheck the whole set immediately before writes. Concurrent edits abort.
    if snapshot(root,inputs)!=original:raise ValueError('Target changed during preflight')
    written=[]
    try:
        for x,target,old,new in pending:
            if (digest(target),target.stat().st_mode&0o777 if target.exists() else None)!=original[x['path']]:raise ValueError('Concurrent edit: '+x['path'])
            if new is None:target.unlink()
            else:atomic_write(target,new,x[mode])
            written.append((x,target,old,new))
        if desired not in classify(snapshot(root,inputs),inputs):raise ValueError('Post-write whole-state verification failed')
    except Exception as error:
        failures=[]
        for x,target,old,new in reversed(written):
            # Never overwrite an edit made after our write.
            try:
                current_hash=digest(target)
                current_mode=target.stat().st_mode&0o777 if current_hash is not None else None
                if (current_hash,current_mode)!=(x[key],x[mode]):
                    failures.append(x['path']+': changed after write; preserved');continue
                if old is None:target.unlink()
                else:atomic_write(target,old,original[x['path']][1])
            except Exception as rollback_error:
                failures.append(x['path']+': '+str(rollback_error))
        try:
            if snapshot(root,inputs)!=original:failures.append('target differs from preflight; concurrent edits preserved')
        except Exception as remaining_error:failures.append('unable to verify restored state: '+str(remaining_error))
        if failures:raise RuntimeError(str(error)+'; recovery incomplete; preserve the tree and inspect: '+'; '.join(failures))
        raise RuntimeError(str(error)+'; completed writes restored to the original whole state')
    return {'mode':command,'from':state,'to':desired,'filesChanged':len(written),'validatedFiles':len(inputs),'databaseTouched':False}
if __name__=='__main__':
    try:
        if len(sys.argv)!=3:raise ValueError('Usage: python3 apply_increment.py check|apply|rollback-previous /path/to/Core')
        print(json.dumps(perform(Path(__file__).parent,sys.argv[2],sys.argv[1]),indent=2))
    except Exception as e:print('STOP: '+str(e),file=sys.stderr);sys.exit(1)
