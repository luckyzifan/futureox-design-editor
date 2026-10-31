"""Execute only the saved straight-line/branch scale selector, not Sketch itself."""
from pathlib import Path
import re,struct,json,hashlib,math
out=Path(__file__).resolve().parent;root=out.parent.parent
source=root.parent/'core/sketch-kernel-analysis/dumps/full/SketchRendering/MSBitmapEffectsContext.txt'
text=source.read_text();body=text.split('### -[MSBitmapEffectsContext imageScaleForBlurRadius:]',1)[1].split('### ',1)[0]
instructions={}
for line in body.splitlines():
    m=re.match(r'\s*([0-9a-f]+):\s+[0-9a-f]+\s+([^;]+)',line)
    if m:instructions[int(m[1],16)]=m[2].strip()
def run(radius):
    d={'d0':float(radius)};x={};at=0x168024;cmp=0
    for _ in range(100):
        instruction=instructions[at];op,args=(instruction.split(None,1)+[''])[:2]
        args=[a.strip() for a in args.split(',')];next_at=at+4
        if op=='ret':return d['d0']
        if op=='mov':x[args[0]]=int(args[1][1:],0)&((1<<64)-1)
        elif op=='movk':
            shift=int(args[2].split('#')[1]) if len(args)>2 else 0
            x[args[0]]=(x[args[0]]&~(0xffff<<shift))|(int(args[1][1:],0)<<shift)
        elif op=='fmov':
            value=args[1]
            d[args[0]]=float(value[1:]) if value.startswith('#') else (d[value] if value.startswith('d') else struct.unpack('<d',x[value].to_bytes(8,'little'))[0])
        elif op=='fcmp':
            a=d[args[0]];b=float(args[1][1:]) if args[1].startswith('#') else d[args[1]]
            assert math.isfinite(a) and math.isfinite(b);cmp=(a>b)-(a<b)
        elif op in ['b','b.le','b.gt']:
            if op=='b' or op=='b.le' and cmp<=0 or op=='b.gt' and cmp>0:next_at=int(args[0].split()[0],16)
        else:raise ValueError(instruction)
        at=next_at
    raise ValueError('selector did not return')
radii=[0,5,5.000001,7,7.000001,9,9.000001,10,10.000001,24,24.000001,48,49,49.000001,100,100.000001]
results=[{'radius':r,'scale':run(r)} for r in radii]
assert run(6)==.9 and run(8)==.8 and run(9.5)==.7 and run(20)==.6 and run(48)==.5 and run(49)==.5 and run(100)==.4 and run(101)==.25
report={'source':str(source),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'saved binary scale-selector instructions; no current Sketch runtime measurement','results':results}
(out/'reverse-blur-table.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
