#!/usr/bin/env python3
"""ABBA child-process CPU and stdio latency; synthetic real SQLite heads, dev binaries."""
import argparse, hashlib, json, math, os, pathlib, sqlite3, statistics, tempfile, time
from verify_stdio import Sidecar, PRESENCE, ID

def cpu_seconds(pid):
    fields=pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()
    return (int(fields[11])+int(fields[12]))/os.sysconf('SC_CLK_TCK')
def quantile(xs,q): return sorted(xs)[max(0,math.ceil(len(xs)*q)-1)]
def seed(sql,count):
    sql.execute("WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?) INSERT INTO documents SELECT printf('10000000-0000-0000-0000-%012x',i),1 FROM seq",(count,))
    sql.execute("INSERT INTO revisions(document_id,revision,name,hash,snapshot,updated_at,deleted) SELECT id,1,'Unicode 雪 metadata',printf('%064d',1),x'7b7d',1000,0 FROM documents")
    sql.commit()
def sample(binary,output,count,scenario,round_number,variant):
    with tempfile.TemporaryDirectory(prefix='bench-',dir=output) as temp:
        root=pathlib.Path(temp).resolve();db=root/'workspace.sqlite3'
        backend=Sidecar(binary,root,db,'observer')
        sql=sqlite3.connect(db,timeout=2)
        try:
            seed(sql,count)
            h=backend.observe()['viewHash']
            for _ in range(3): backend.observe(h)
            polls={1:300,1000:100,10000:30}[count]
            latency=[];response_bytes=0;changed=0
            p=dict(PRESENCE,id='20000000-0000-0000-0000-000000000002',name='Peer')
            start_cpu=cpu_seconds(backend.p.pid)
            for i in range(polls):
                if scenario=='presence_only':
                    p['cursor']=[i+.25,i+.75]
                    sql.execute('INSERT INTO local_sessions(id,document_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',(p['id'],ID,json.dumps(p,separators=(',',':')).encode(),int(time.time()*1000)))
                    sql.commit()
                elif scenario=='each_poll_head_change':
                    sql.execute('UPDATE revisions SET updated_at=? WHERE document_id=?',(2000+i,ID));sql.commit()
                start=time.perf_counter_ns();out=backend.observe(h);latency.append((time.perf_counter_ns()-start)/1e6)
                assert out['changed'] == (scenario=='each_poll_head_change')
                if scenario=='presence_only': assert out['peers'][0]['cursor']==p['cursor']
                h=out['viewHash'];changed+=int(out['changed'])
                response_bytes+=len(json.dumps(out,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
            cpu=cpu_seconds(backend.p.pid)-start_cpu
            return dict(heads=count,scenario=scenario,round=round_number,variant=variant,polls=polls,child_cpu_seconds=cpu,child_cpu_ms_per_poll=cpu*1000/polls,wall_p50_ms=statistics.median(latency),wall_p95_ms=quantile(latency,.95),response_payload_bytes=response_bytes,changed_polls=changed,latency_ms=latency)
        finally: sql.close();backend.close()
def main(args):
    rows=[]
    for count in [1,1000,10000]:
        for scenario in ['unchanged','presence_only','each_poll_head_change']:
            for round_number,variant in enumerate(['baseline','candidate','candidate','baseline'],1):
                binary=getattr(args,variant)
                row=sample(binary,args.output,count,scenario,round_number,variant);rows.append(row)
                print(json.dumps({k:v for k,v in row.items() if k!='latency_ms'}),flush=True)
                pathlib.Path(args.output,'benchmark-progress.json').write_text(json.dumps(rows,indent=2)+'\n')
    summary=[]
    for count in [1,1000,10000]:
        for scenario in ['unchanged','presence_only','each_poll_head_change']:
            grouped={v:[r for r in rows if r['heads']==count and r['scenario']==scenario and r['variant']==v] for v in ['baseline','candidate']}
            base=sum(r['child_cpu_seconds'] for r in grouped['baseline']);cand=sum(r['child_cpu_seconds'] for r in grouped['candidate'])
            summary.append(dict(heads=count,scenario=scenario,baseline_cpu_ms_per_poll=base*1000/sum(r['polls'] for r in grouped['baseline']),candidate_cpu_ms_per_poll=cand*1000/sum(r['polls'] for r in grouped['candidate']),cpu_reduction_percent=100*(1-cand/base) if base else None))
    result=dict(profile='Cargo dev opt-level=0, debug=0; CPU production methods through stdio',clock_ticks_per_second=os.sysconf('SC_CLK_TCK'),order='ABBA for each size/scenario',warmup_polls=4,baseline_sha256=hashlib.sha256(pathlib.Path(args.baseline).read_bytes()).hexdigest(),candidate_sha256=hashlib.sha256(pathlib.Path(args.candidate).read_bytes()).hexdigest(),rows=rows,summary=summary,limits=['Synthetic SQLite metadata rows; document snapshot decoding is not part of observe.','Child CPU is /proc process user+system ticks, excludes harness/external writer CPU.','Wall latency includes pipes and Python JSON parse; no UI/GPU/FPS or release-profile claim.','Presence-only and head-change writes are a separate SQLite connection, outside each timed observe.','Retained cache cap is not a whole-process or concurrent temporary allocation cap.'])
    pathlib.Path(args.output,'benchmark-results.json').write_text(json.dumps(result,indent=2)+'\n')
    print('SUMMARY '+json.dumps(summary),flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--baseline',required=True);p.add_argument('--candidate',required=True);p.add_argument('--output',required=True);main(p.parse_args())
