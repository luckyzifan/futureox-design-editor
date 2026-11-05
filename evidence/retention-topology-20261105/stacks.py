"""Symbolicate large native allocations and join allocation/free addresses to Mach samples."""
import bisect, collections, json, re, statistics, subprocess, sys
from pathlib import Path

trace, binary, output=map(Path,sys.argv[1:4])
stacks={};events=[];samples=[];regions=collections.defaultdict(list);tail_frees=collections.defaultdict(list);overflow=None
for raw in trace.read_text().splitlines():
    row=raw.split();kind=row[0]
    if kind=='H': threshold,page,base=int(row[1]),int(row[2]),int(row[3],16)
    elif kind=='K': stacks[int(row[1])]=[int(v,16) for v in row[2:]]
    elif kind=='A': events.append((int(row[1]),1,int(row[2],16),int(row[3]),int(row[4]),int(row[5])))
    elif kind=='F': events.append((int(row[1]),0,int(row[2],16)))
    elif kind=='Y': tail_frees[int(row[4])].append(int(row[3]))
    elif kind in ('S','E'):
        s=dict(zip(['t','rss','footprint','internal','compressed','reusable','live','reserved','blocks'],map(int,row[1:])))
        samples.append(s)
    elif kind=='R':regions[int(row[1])].append((int(row[2],16),*map(int,row[3:])))
    elif kind=='X':overflow=int(row[1])
assert overflow==0
keys=sorted({pc for st in stacks.values() for pc in st})
symbols={}
for i in range(0,len(keys),240):
    part=keys[i:i+240]
    lines=subprocess.check_output(['atos','-o',binary,'-l','0x100000000',*[hex(0x100000000+p-1) for p in part]],text=True).splitlines()
    assert len(lines)==len(part)
    for k,v in zip(part,lines):symbols[k]=re.sub(r'::h[0-9a-f]{16}\b','',v.split(' (in ')[0])
names={k:[symbols[pc] for pc in st] for k,st in stacks.items()}
events.sort(key=lambda e:e[0]); active={};lives=[];unmatched=0;collisions=0
for e in events:
    t,alloc,ptr=e[:3]
    if alloc:
        if ptr in active:collisions+=1
        active[ptr]=e
    elif ptr in active:
        a=active.pop(ptr)
        lives.append((a[0],t,ptr,a[3],a[4],a[5]))
    else:unmatched+=1 # rounded malloc blocks straddling the trace threshold, or pre-constructor owners
end=samples[-1]['t']
lives.extend((v[0],end+1,k,v[3],v[4],v[5]) for k,v in active.items())
def bucket(stack):
    fn=[s for s in stack if any(k in s for k in ['futureox_design_kernel::','cpu_frame_probe::'])]
    return ' > '.join(fn[:5]) or (stack[0] if stack else 'system')
label={s:bucket(v) for s,v in names.items()}
def breakdown(t):
    by=collections.Counter(); counts=collections.Counter()
    for born,freed,ptr,req,n,st in lives:
        if born<=t<freed:by[label[st]]+=n; counts[label[st]]+=1
    return dict(largeLive=sum(by.values()),owners=[dict(stack=k,bytes=v,blocks=counts[k]) for k,v in by.most_common(18)])
def nearest(t):
    return min(samples,key=lambda s:abs(s['t']-t))
def observation(s):
    reg=min(regions,key=lambda t:abs(t-s['t']))
    tags=collections.Counter()
    for addr,size,tag,res,reuse,swap in regions[reg]:tags[tag]+=res*page
    return {**s,**breakdown(s['t']), 'mallocResidentByTag':dict(tags),'regionSkewMs':round((reg-s['t'])/1e6,2)}
peaks={k:observation(max(samples,key=lambda s:s[k])) for k in ['rss','footprint','live','reserved','reusable']}
# The 16 MiB frame output belongs directly to render_linear, outside the nested tile surface stacks.
frames=[v for v in lives if v[3]==16*1024**2 and label[v[-1]].startswith('futureox_design_kernel::renderer::Engine::render_linear >')]
frames.sort()
tile_stacks={v[-1] for v in lives if v[3]==4*1024**2 and
             label[v[-1]].startswith('futureox_design_kernel::renderer::Engine::linear_rect_pixels')}
lifetimes=collections.defaultdict(list)
for born,freed,ptr,req,n,st in lives:lifetimes[label[st]].append((born,freed,n))
owners=[]
for k,rows in lifetimes.items():
    points=sorted([(x,n) for x,y,n in rows]+[(y,-n) for x,y,n in rows])
    current=peak=0
    for _,n in points:current+=n;peak=max(peak,current)
    owners.append(dict(stack=k,allocations=len(rows),totalBytes=sum(v[2] for v in rows),peakLive=peak,
        medianLifeMs=round(statistics.median((y-x)/1e6 for x,y,n in rows),2),maxLifeMs=round(max((y-x)/1e6 for x,y,n in rows),2)))
owners.sort(key=lambda d:-d['peakLive'])
frame_info=[]
for x,y,addr,req,n,st in frames:
    inside=[s for s in samples if x<=s['t']<y]
    if inside:frame_info.append(dict(start=nearest(x),end=nearest(y),peak=observation(max(inside,key=lambda s:s['rss']))))
out=dict(threshold=threshold,pageBytes=page,objects=len(lives),stackCount=len(stacks),addressCollisions=collisions,
         unpairedFrees=unmatched,samples=len(samples),peaks=peaks,frameBoundaries=frame_info,
         landmarkStacks={'tile':sorted(tile_stacks),'frame':sorted({v[-1] for v in frames})},
         freesAfterLastTile=[dict(bytes=sum(v),objects=len(v),stack=names[k]) for k,v in
                             sorted(tail_frees.items(),key=lambda x:-sum(x[1]))],
         owners=owners[:75],last=observation(samples[-1]))
output.write_text(json.dumps(out,indent=2)+'\n')
print(binary.name,len(frames),'frames;',len(lives),'allocations;',len(samples),'VM samples')
for k,v in peaks.items():print(k, *(f'{n}={v[n]/2**20:.1f}' for n in ['rss','live','largeLive','footprint','reserved','compressed','reusable']))
for d in peaks['rss']['owners'][:9]: print(round(d['bytes']/2**20,2),d['stack'][:185])
