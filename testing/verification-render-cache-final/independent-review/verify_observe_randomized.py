#!/usr/bin/env python3
"""Independent black-box canonical oracle against real baseline/candidate stdio.

Uses only existing executables, no compilation, browser, GPU, socket or network.
Seeds are fixed. Every mutation acts on an isolated throwaway SQLite workspace.
"""
import hashlib, json, os, pathlib, random, select, sqlite3, subprocess, sys, tempfile

OUT = pathlib.Path(__file__).resolve().parent
BASE = pathlib.Path(os.environ.get('REVIEW_BASELINE_EXECUTABLE', OUT.parent / 'workspace-observe/baseline/backend'))
CANDIDATE = pathlib.Path(os.environ.get('REVIEW_CANDIDATE_EXECUTABLE', OUT.parent / 'workspace-observe/cargo-target/debug/futureox-design-desktop-backend'))
DOC_IDS = [f'11111111-0000-0000-0000-{i:012x}' for i in range(1, 5)]
PAGE = '11111111-0000-0000-0001-000000000001'
PRESENCE = dict(id='22222222-0000-0000-0000-000000000001',name='Independent review',documentId=DOC_IDS[0],pageId=PAGE,view=[0,0,1],cursor=None,selection=[])

class Sidecar:
    def __init__(self, binary, root, db, label):
        self.n=0
        self.stderr=open(OUT / (label+'.stderr.log'),'ab')
        self.proc=subprocess.Popen([str(binary),'--recovery-dir',str(root/(label+'.recovery')),'--catalog-db',str(root/(label+'.catalog')),'--workspace-db',str(db)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.stderr)
        assert self.call('health',{})['workspaceVersion']==5
    def raw(self,method,params):
        self.n+=1
        self.proc.stdin.write((json.dumps(dict(id=self.n,method=method,params=params),ensure_ascii=False)+'\n').encode())
        self.proc.stdin.flush()
        assert select.select([self.proc.stdout],[],[],15)[0], 'stdio timeout'
        result=json.loads(self.proc.stdout.readline());assert result['id']==self.n
        result.pop('id');return result
    def call(self,method,params):
        response=self.raw(method,params);assert 'result' in response,response;return response['result']
    def observe(self,h):
        return self.call('workspace.observe',dict(control=dict(messageType='subscribe',view_name='workspace',view_hash=h),presence=PRESENCE))
    def close(self):
        if self.proc.poll() is None:self.proc.stdin.close();self.proc.wait(timeout=15)
        self.stderr.close()

def main():
    checks=[];rng=random.Random(73151)
    with tempfile.TemporaryDirectory(prefix='independent-observe-',dir=OUT) as tmp:
        root=pathlib.Path(tmp).resolve();db=root/'workspace.sqlite3';a=Sidecar(BASE,root,db,'random-baseline');b=Sidecar(CANDIDATE,root,db,'random-candidate')
        sql=sqlite3.connect(db,timeout=5)
        try:
            for i,docid in enumerate(DOC_IDS):
                d=dict(schemaVersion=6,id=docid,name=f'Document {i}',pages=[dict(id=PAGE,name='Page',background='#ffffff',children=[])],nodes={})
                a.call('workspace.commit',dict(document=d,expectedRevision=None,mutationId=f'independent-create-{i}'))
            known_hashes=[]
            def verify(label, supplied=''):
                expected=a.observe(supplied);actual=b.observe(supplied);assert actual==expected,(label,expected,actual)
                full=a.call('workspace.list',{})
                canonical=json.dumps(full,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
                h=hashlib.sha256(canonical).hexdigest()
                assert actual['viewHash']==h,(label,'noncanonical hash')
                assert actual['changed']==(h!=supplied)
                assert actual['documents']==(full['documents'] if h!=supplied else None)
                checks.append(label);known_hashes.append(h);return h
            h=verify('initial')
            # Single-field churn, tied sort keys, empty/control/Unicode names,
            # repeated values and ABA reversions; stale hash still returns list.
            for i in range(96):
                docid=rng.choice(DOC_IDS);field=rng.choice(['name','hash','updated_at','deleted'])
                value={'name':rng.choice(['', '雪🧪 / \\ \"', 'A\nB\tC\u0000D', 'same', 'x'*513]),'hash':rng.choice(['1'*64,'2'*64,'3'*64]),'updated_at':rng.choice([0,1,2,9007199254740991]),'deleted':rng.choice([0,1])}[field]
                sql.execute(f'UPDATE revisions SET {field}=? WHERE document_id=?',(value,docid))
                if i%7==0:sql.rollback()
                else:sql.commit()
                supplied=rng.choice([h,'',*known_hashes[-4:]])
                h=verify(f'change-{i:02d}-{field}',supplied)
                assert not b.observe(h)['changed'];checks.append(f'warm-{i:02d}')
            # A failed fresh query must still fail after a warm hash hit.
            sql.execute('ALTER TABLE revisions RENAME TO temporarily_missing');sql.commit()
            params=dict(control=dict(messageType='subscribe',view_name='workspace',view_hash=h),presence=PRESENCE)
            left=a.raw('workspace.observe',params);right=b.raw('workspace.observe',params)
            assert left['error']['code']==right['error']['code']=='WORKSPACE_ERROR';checks.append('failed-query-after-warm')
            sql.execute('ALTER TABLE temporarily_missing RENAME TO revisions');sql.commit();h=verify('restore-table-after-error',h)
            b.close();b=Sidecar(CANDIDATE,root,db,'random-candidate-restarted');verify('restart-after-churn',h)
            assert sql.execute('PRAGMA user_version').fetchone()[0]==5
        finally:
            sql.close();a.close();b.close()
    result=dict(status='pass',checks=checks,count=len(checks),seed=73151,transport='stdio only',baseline_sha256=hashlib.sha256(BASE.read_bytes()).hexdigest(),candidate_sha256=hashlib.sha256(CANDIDATE.read_bytes()).hexdigest(),scope='Observation protocol equivalence; no GPU/browser/in-app visual claim')
    (OUT/'observe-randomized-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='checks'},ensure_ascii=False))

if __name__=='__main__':main()
