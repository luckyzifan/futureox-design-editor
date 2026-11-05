"""python3 compare.py WORKDIR FONT {bounds|qa|timing|rss}; A/B are native probe executables."""
import filecmp, hashlib, json, os, platform, re, statistics, subprocess, sys, tempfile
from pathlib import Path
from array import array

folder = Path(sys.argv[1]).resolve()
font = sys.argv[2]
def sha(value): return hashlib.sha256(value).hexdigest()
def run(arm,mode,doc,view,*args):
    cmd=[str(folder/arm),mode,str(folder/(doc+'.json')),str(folder/(view+'.json')),font if doc=='117' else '-',*map(str,args)]
    with tempfile.TemporaryFile() as stream:
        proc=subprocess.Popen(cmd,stdout=stream)
        _,st,usage=os.wait4(proc.pid,0)
        proc.returncode=os.waitstatus_to_exitcode(st)
        if proc.returncode: raise RuntimeError((arm,mode,doc,view,proc.returncode))
        stream.seek(0)
        return stream.read(),usage.ru_maxrss*(1 if sys.platform=='darwin' else 1024)
def floats(raw):
    v=array('f');v.frombytes(raw)
    if sys.byteorder!='little': v.byteswap()
    return v

def timing_cases():
    for doc in ['sparse','117']:
        for side in [512,1024,2048]:
            yield doc,side,(f'sparse-{side}' if doc=='sparse' else f'117-overview-{side}')

if sys.argv[3]=='rss':
    # Independent follow-up on the matrix cell that crossed the memory observation
    # threshold. Same binaries, document, font, default budget and three frames.
    assert sys.platform=='darwin'
    results={'A':[],'B':[]}
    for arm in 'BAABABBA':
        call=subprocess.run(['/usr/bin/time','-l',folder/arm,'measure',folder/'117.json',
                             folder/'117-overview-1024.json',font],capture_output=True,text=True,check=True)
        def metric(label):
            return int(re.search(r'^\s*(\d+)\s+'+label+r'\s*$',call.stderr,re.MULTILINE).group(1))
        row=dict(rssBytes=metric('maximum resident set size'),footprintBytes=metric('peak memory footprint'),
                 frames=json.loads(call.stdout))
        results[arm].append(row)
        print(arm,row['rssBytes'],row['footprintBytes'],flush=True)
    (folder/'rss-check.json').write_text(json.dumps(dict(order='BAABABBA',samples=results),indent=2)+'\n')
elif sys.argv[3]=='bounds':
    checks={}
    for side in [1024,2048]:
        for arm in ['A','B']:
            r=subprocess.run([folder/arm,'pixels',folder/'117.json',folder/f'117-{side}.json',font,folder/'rejected'],
                             capture_output=True,text=True)
            error=r.stderr.strip()
            assert r.returncode!=0 and 'Compositing memory budget exceeded' in error,(arm,side,error)
            checks[f'{arm}-{side}']=error
    (folder/'refusals.json').write_text(json.dumps(checks,indent=2)+'\n')
elif sys.argv[3]=='qa':
    results={}
    for case in ['blur','backdrop','mask','zoom','hdr']:
        view=case+'-view'; w=json.loads((folder/(view+'.json')).read_text())['width']
        seam=256 if case=='hdr' else 512
        for arm in ['A','B']:
            run(arm,'hdr' if case=='hdr' else 'pixels',case,view,folder/(arm+'-'+case))
        run('A','pixels',case+'-off',view,folder/('off-'+case))
        first=(folder/('A-'+case+'.f32')).read_bytes()
        assert first==(folder/('B-'+case+'.f32')).read_bytes(),case
        off=(folder/('off-'+case+'.f32')).read_bytes()
        sides=[0,0,0,0]; total=0
        for i in range(0,len(off),16):
            if first[i:i+16]!=off[i:i+16]:
                total+=1; x=i//16%w; y=i//16//w
                for j,pos in enumerate([x,y]):
                    if pos in (seam-1,seam): sides[2*j+int(pos==seam)]+=1
        assert all(sides),(case,sides)
        results[case]=dict(floatHash=sha(first),channels=len(first)//4,seamCounts=sides,changedPixels=total)
        if case=='hdr':
            for ext in ['png','rgba16']:
                raw=(folder/('A-hdr.'+ext)).read_bytes()
                assert raw==(folder/('B-hdr.'+ext)).read_bytes(),ext
                results[case][ext+'Hash']=sha(raw)
            results[case]['maxLinear']=max(floats(first))
            assert results[case]['maxLinear']>1
    for doc,side,key in timing_cases():
        for arm in 'AB': run(arm,'pixels',doc,key,folder/(arm+'-matrix'))
        a,b=[folder/(arm+'-matrix.f32') for arm in 'AB']
        assert a.stat().st_size==side*side*16 and filecmp.cmp(a,b,shallow=False),key
        with a.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
        results[key]=dict(floatHash=digest,channels=side*side*4)
        a.unlink(); b.unlink()
    (folder/'qa.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(results,indent=2))
else:
    results={}
    for doc,side,key in timing_cases():
        arms={'A':[],'B':[]}
        for arm in 'ABBAABBA':
            raw,rss=run(arm,'measure',doc,key)
            frames=json.loads(raw); assert all(f['tiles']==(side//512)**2 for f in frames)
            arms[arm].append(dict(frames=frames,processPeakBytes=rss))
        medians={}
        for arm,runs in arms.items():
            warm=[f for r in runs for f in r['frames'][1:]]
            medians[arm]={k:statistics.median(f[k] for f in warm) for k in warm[0]}
            medians[arm]['processPeakBytes']=statistics.median(r['processPeakBytes'] for r in runs)
        results[key]=dict(samples=arms,medians=medians,docHash=sha((folder/(doc+'.json')).read_bytes()),
                          view=json.loads((folder/(key+'.json')).read_text()))
        print(key,medians,flush=True)
        (folder/'timing.json').write_text(json.dumps(dict(platform=platform.platform(),
             binaries={a:sha((folder/a).read_bytes()) for a in 'AB'},cases=results),indent=2)+'\n')
