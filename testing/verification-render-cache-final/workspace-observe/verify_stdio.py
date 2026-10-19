#!/usr/bin/env python3
"""Real baseline/candidate sidecars and SQLite, over pipes only (no sockets)."""
import argparse, hashlib, json, os, pathlib, select, sqlite3, subprocess, tempfile, time

ID = '10000000-0000-0000-0000-000000000001'
PAGE = '10000000-0000-0000-0000-000000000002'
PRESENCE = dict(id='20000000-0000-0000-0000-000000000001',name='Observer 雪',documentId=ID,pageId=PAGE,view=[0,0,1],cursor=[1.25,2.5],selection=[])
def document(name):
    return dict(schemaVersion=6,id=ID,name=name,pages=[dict(id=PAGE,name='Page',background='#ffffff',children=[])],nodes={})
class Sidecar:
    def __init__(self, binary, root, db, label):
        self.binary, self.root, self.db, self.label = str(binary), pathlib.Path(root), str(db), label
        self.n = 0
        self.stderr = open(self.root / (label+'.stderr.log'), 'ab')
        self.p = subprocess.Popen([self.binary,'--recovery-dir',str(self.root/(label+'-recovery')),'--catalog-db',str(self.root/(label+'-catalog.sqlite3')),'--workspace-db',self.db],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.stderr)
        health=self.call('health',{})
        assert health['workspaceAvailable'], health
        assert health['workspaceVersion'] == 5, health
    def send(self, method, params):
        self.n+=1
        self.p.stdin.write((json.dumps(dict(id=self.n,method=method,params=params),ensure_ascii=False,separators=(',',':'))+'\n').encode())
        self.p.stdin.flush()
        return self.n
    def response(self, request_id):
        assert select.select([self.p.stdout],[],[],30)[0], 'sidecar response timeout'
        line=self.p.stdout.readline()
        assert line, ('sidecar exited',self.p.poll())
        result=json.loads(line)
        assert result['id'] == request_id, result
        return result
    def raw(self,method,params): return self.response(self.send(method,params))
    def call(self,method,params):
        result=self.raw(method,params)
        assert 'result' in result, result
        return result['result']
    def observe(self, h='', p=None):
        return self.call('workspace.observe',dict(control=dict(messageType='subscribe',view_name='workspace',view_hash=h),presence=p or PRESENCE))
    def close(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        self.stderr.close()
    def kill(self):
        self.p.kill(); self.p.wait(timeout=10); self.stderr.close()

def schema_one(db):
    with sqlite3.connect(db) as c:
        c.executescript('''CREATE TABLE documents(id TEXT PRIMARY KEY,head_revision INTEGER NOT NULL CHECK(head_revision>0));
CREATE TABLE revisions(document_id TEXT NOT NULL REFERENCES documents(id),revision INTEGER NOT NULL CHECK(revision>0),name TEXT NOT NULL,hash TEXT NOT NULL CHECK(length(hash)=64),snapshot BLOB NOT NULL,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),PRIMARY KEY(document_id,revision));
CREATE TABLE mutations(mutation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),document_id TEXT NOT NULL,revision INTEGER NOT NULL,FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));
PRAGMA user_version=1;''')

def verify(baseline,candidate,output):
    checks=[]
    with tempfile.TemporaryDirectory(prefix='observe-stdio-',dir=output) as temp:
        root=pathlib.Path(temp).resolve(); db=root/'workspace.sqlite3'
        schema_one(db)
        a=Sidecar(baseline,root,db,'baseline')
        b=Sidecar(candidate,root,db,'candidate')
        writer=Sidecar(baseline,root,db,'old-writer')
        try:
            sql=sqlite3.connect(db,timeout=2)
            before_schema=sql.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
            def pair(label,h='',p=None):
                expected=a.observe(h,p); actual=b.observe(h,p)
                assert actual == expected, (label,actual,expected)
                listed=a.call('workspace.list',{})
                canonical=json.dumps(listed,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
                assert actual['viewHash'] == hashlib.sha256(canonical).hexdigest(), label
                assert actual['changed'] == (actual['viewHash'] != h)
                assert actual['documents'] == (listed['documents'] if actual['changed'] else None)
                checks.append(label)
                return actual
            first=pair('schema-1-upgrade-empty')
            first_doc=document('first 雪 " \\ /')
            committed=writer.call('workspace.commit',dict(document=first_doc,expectedRevision=None,mutationId='first'))
            current=pair('old-writer-insert',first['viewHash'])
            pair('warm-unchanged',current['viewHash'])
            pair('empty-hash-returns-exact-list','')
            pair('stale-hash-returns-exact-list','stale')
            p=dict(PRESENCE,id='20000000-0000-0000-0000-000000000002',name='Peer')
            for i in range(10):
                p['cursor']=[i+0.25,i+0.75]; writer.observe(current['viewHash'],p)
                out=pair('presence-churn-'+str(i),current['viewHash'])
                assert out['peers'][0]['cursor'] == p['cursor']
            sql.execute('UPDATE local_sessions SET updated_at=0 WHERE id=?',(p['id'],));sql.commit()
            assert pair('presence-expiry',current['viewHash'])['peers'] == []
            sql.execute("UPDATE revisions SET name='rolled back'");sql.rollback()
            assert not pair('external-rollback',current['viewHash'])['changed']
            sql.executescript("CREATE TRIGGER fail_receipt BEFORE INSERT ON mutations WHEN new.mutation_id='fail' BEGIN SELECT RAISE(ABORT,'test rollback'); END;")
            failed=writer.raw('workspace.commit',dict(document=document('failed'),expectedRevision=1,mutationId='fail'))
            assert failed['error']['code']=='WORKSPACE_ERROR'
            assert not pair('failed-transaction-rollback',current['viewHash'])['changed']
            assert writer.call('workspace.commit',dict(document=first_doc,expectedRevision=None,mutationId='first')) == committed
            assert not pair('idempotent-replay',current['viewHash'])['changed']
            unknown_doc=document('unknown acknowledged later')
            writer.send('workspace.commit',dict(document=unknown_doc,expectedRevision=1,mutationId='unknown'))
            end=time.monotonic()+10
            while sql.execute("SELECT count(*) FROM mutations WHERE mutation_id='unknown'").fetchone()[0] == 0:
                assert time.monotonic()<end
                time.sleep(.01)
            writer.kill() # The reply is deliberately never read.
            writer=Sidecar(baseline,root,db,'old-writer-restarted')
            retry=writer.call('workspace.commit',dict(document=unknown_doc,expectedRevision=1,mutationId='unknown'))
            assert retry['revision']==2
            current=pair('unknown-outcome-retry-after-writer-restart',current['viewHash'])
            writer.call('workspace.trash',dict(id=ID,expectedRevision=2,mutationId='trash'))
            current=pair('old-writer-trash',current['viewHash']);assert current['documents']==[]
            writer.call('workspace.restore',dict(id=ID,revision=1,expectedRevision=3,mutationId='restore'))
            current=pair('old-writer-restore',current['viewHash']);assert current['documents'][0]['revision']==4
            # External in-place metadata writes, including same timestamp and old hash.
            for field,value in [('name','external metadata'),('hash','2'*64),('updated_at',1000),('deleted',1),('deleted',0)]:
                sql.execute(f'UPDATE revisions SET {field}=? WHERE revision=4',(value,));sql.commit()
                current=pair('external-current-'+field+'-'+str(value),current['viewHash'])
            sql.execute("UPDATE revisions SET name='history-only' WHERE revision=1");sql.commit()
            assert not pair('history-only-write',current['viewHash'])['changed']
            b.close();b=Sidecar(candidate,root,db,'candidate-restarted')
            assert not pair('candidate-restart-retains-hash',current['viewHash'])['changed']
            for h in ['x'*128,'x'*129]:
                params=dict(control=dict(messageType='subscribe',view_name='workspace',view_hash=h),presence=PRESENCE)
                x=a.raw('workspace.observe',params);y=b.raw('workspace.observe',params)
                x.pop('id');y.pop('id');assert x==y
                checks.append('hash-limit-'+str(len(h)))
            # New roots must never inherit the previous process's cached heads.
            other=root/'other.sqlite3'
            c=Sidecar(candidate,root,other,'candidate-other-root')
            try: assert c.observe(current['viewHash'])['documents']==[]
            finally: c.close()
            checks.append('root-isolation')
            after_schema=sql.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name!='fail_receipt' ORDER BY type,name").fetchall()
            assert before_schema==after_schema
            assert sql.execute('PRAGMA user_version').fetchone()[0]==5
            checks.append('no-added-schema-or-generation')
            sql.execute('ALTER TABLE revisions RENAME TO missing_revisions');sql.commit()
            params=dict(control=dict(messageType='subscribe',view_name='workspace',view_hash=current['viewHash']),presence=PRESENCE)
            x=a.raw('workspace.observe',params);y=b.raw('workspace.observe',params)
            assert x['error']['code']==y['error']['code']=='WORKSPACE_ERROR'
            checks.append('failed-select-does-not-return-cache')
            sql.close()
        finally:
            a.close();b.close();writer.close()
    result=dict(passed=len(checks),checks=checks,baseline_sha256=hashlib.sha256(pathlib.Path(baseline).read_bytes()).hexdigest(),candidate_sha256=hashlib.sha256(pathlib.Path(candidate).read_bytes()).hexdigest(),transport='stdio pipes',schema_version=5)
    pathlib.Path(output,'stdio-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--baseline',required=True);p.add_argument('--candidate',required=True);p.add_argument('--output',required=True);a=p.parse_args();verify(a.baseline,a.candidate,a.output)
