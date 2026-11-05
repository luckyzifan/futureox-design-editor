"""Match mincore-confirmed malloc-large resident pages to their last observed malloc/free."""
from pathlib import Path
import collections,json,subprocess,sys

trace,binary,out=map(Path,sys.argv[1:]);page=0;stacks={};ev=[];marks=[];regions=collections.defaultdict(list)
for line in trace.read_text().splitlines():
    z=line.split();tag=z[0]
    if tag=='H':page=int(z[2])
    elif tag=='K':stacks[int(z[1])]=[int(s,16) for s in z[2:]]
    elif tag=='A':ev.append((int(z[1]),'a',int(z[2],16),int(z[4]),int(z[5])))
    elif tag=='F':ev.append((int(z[1]),'f',int(z[2],16),0,0))
    elif tag=='V':regions[int(z[1])].append((int(z[2],16)//page,int(z[3])))
    elif tag in ['T','G','P','S','E']:
        marks.append(dict(kind=tag,**dict(zip(('at','rss','footprint','internal','compressed','reusable','live','reserved','blocks'),map(int,z[1:])))))
pcs=sorted({pc for seq in stacks.values() for pc in seq});symbols={}
for j in range(0,len(pcs),250):
    seq=pcs[j:j+250];names=subprocess.check_output(['atos','-o',binary,'-l','0x100000000',*[hex(0x100000000+pc-1) for pc in seq]],text=True).splitlines()
    symbols.update(zip(seq,names))
def classify(s):
    names=[symbols[x].split(' (in ')[0].split('::h')[0] for x in stacks[s]]
    if any('Surface::new_accounted' in x for x in names):
        if any('paint::decode' in x for x in names):return 'decoded image'
        if any('Painter::allocate_bundle' in x for x in names):return 'painter four-plane layers'
        if any('gaussian_surface' in x or 'blur::' in x or 'blur_surface' in x for x in names):return 'filter surfaces'
        if any('Painter::' in x for x in names):return 'other painter surfaces'
        return 'frame sample surfaces'
    for needle,label in [('cpu_frame_plan','frame geometry'),('font::Fonts::load','font data'),('paint::','image resources'),('geometry_snapshot','geometry preparation'),('linear_rect_pixels','tile output'),('Engine::render_linear','frame output')]:
        if any(needle in x for x in names):return label
    return 'other'
labels={k:classify(k) for k in stacks}
indices=[m for m in marks if m['kind'] in ['T','G','P','E']]
for metric in ['rss','footprint','live']:
    peak=max((m for m in marks if m['kind']=='S'),key=lambda m:m[metric]);indices.append({**peak,'kind':'peak-'+metric})
owners={};active={};ev.sort();idx=0;details=[]
for m in sorted(indices,key=lambda m:m['at']):
    ts=min(regions,key=lambda x:abs(x-m['at']))
    while idx<len(ev) and ev[idx][0]<=ts:
        at,k,addr,size,st=ev[idx];idx+=1
        if k=='a':
            interval=range((addr+page-1)//page,(addr+size)//page); active[addr]=(interval,st,at)
            for pg in interval:owners[pg]=(st,True,at)
        elif addr in active:
            interval,st,born=active.pop(addr)
            for pg in interval:
                if owners.get(pg)==(st,True,born):owners[pg]=(st,False,born)
    counts=collections.Counter()
    for start,n in regions[ts]:
        for pg in range(start,start+n):
            if pg in owners:
                st,live,_=owners[pg];counts[('live: ' if live else 'released: ')+labels[st]]+=page
            else:counts['unattributed']+=page
    details.append(dict(**m,skewMs=round((ts-m['at'])/1e6,3),residentLargePagesByLastObject=dict(counts)))
out.write_text(json.dumps(details,indent=2)+'\n')
