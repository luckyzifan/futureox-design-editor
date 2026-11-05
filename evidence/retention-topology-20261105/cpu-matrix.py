"""Native comparison: WORKDIR ORIGINAL_CPU_WORKDIR FONT. C is the new executable."""
import hashlib,json,re,statistics,subprocess,sys
from pathlib import Path
d,old,font=map(Path,sys.argv[1:]);out={}
arms={'A':old/'A','B':old/'B','C':d/'C'}
for doc,prefix in [('sparse','sparse'),('117','117-overview')]:
    for side in (512,1024,2048):
        key=f'{prefix}-{side}';rows={a:[] for a in arms}
        # All three arms see early, middle, and late positions in fresh processes.
        for arm in 'ABCCBABACCAB':
            r=subprocess.run(['/usr/bin/time','-l',arms[arm],'measure',old/(doc+'.json'),old/(key+'.json'),
                              font if doc=='117' else '-'],capture_output=True,text=True,check=True)
            frames=json.loads(r.stdout);assert all(f['tiles']==(side//512)**2 for f in frames)
            def value(label):return int(re.search(r'^\s*(\d+)\s+'+label+r'\s*$',r.stderr,re.M).group(1))
            rows[arm].append(dict(frames=frames,rss=value('maximum resident set size'),footprint=value('peak memory footprint')))
        def median(samples):
            warm=[f for r in samples for f in r['frames'][1:]]
            return {**{k:statistics.median(f[k] for f in warm) for k in warm[0]},
                    **{k:statistics.median(r[k] for r in samples) for k in ['rss','footprint']}}
        out[key]=dict(medians={a:median(v) for a,v in rows.items()},samples=rows)
        (d/'cpu-matrix.json').write_text(json.dumps(dict(order='ABCCBABACCAB',binaries={a:hashlib.sha256(b.read_bytes()).hexdigest() for a,b in arms.items()},cases=out),indent=2)+'\n')
        print(key,out[key]['medians'],flush=True)
