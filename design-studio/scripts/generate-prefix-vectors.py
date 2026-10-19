"""Independent integer/Fraction vectors for the production prefix WGSL helper."""
from pathlib import Path
from fractions import Fraction
import argparse, importlib.util, json, random, hashlib, tempfile, uuid

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,help='New or empty evidence directory')
args=parser.parse_args()
OUT=args.output or Path(tempfile.gettempdir())/('forma-prefix-vectors-'+str(uuid.uuid4()))
OUT.mkdir(parents=True,exist_ok=True)
if any(OUT.iterdir()):raise SystemExit('Refusing non-empty vector output: '+str(OUT))
spec=importlib.util.spec_from_file_location('oracle',ROOT/'design-studio/scripts/generate-precision-vectors.py')
oracle=importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
MASK=(1<<128)-1; U32=(1<<32)-1; rng=random.Random(2026101103)
rows=[]; counts={}
def limbs(n): return [(n>>(32*i))&U32 for i in range(4)]
def row(name,op,a,b,expected):
    words=[op]+list(a)+list(b)
    assert len(words)<=16 and len(expected)==4
    rows.append([words+[0]*(16-len(words)),expected]); counts[name]=counts.get(name,0)+1
def pack(n,d,q):
    expected=oracle.binary32(Fraction(n,d)*oracle.power(q))
    row('pack',0,limbs(n),[d,q&U32],[expected,1,0,0])

# Every quantum, every legal tent denominator; exponent/mantissa, limb and tie boundaries.
for q in range(-149,105):
    for n in [0,1,2,3,(1<<23)-1,1<<23,(1<<23)+1,(1<<24)-1,(1<<24)+1,
              (1<<31)-1,1<<32,(1<<63)+1,(1<<64)-1,(1<<84)+1,(1<<94)-1]:
        for sign in [-1,1]:
            pack(sign*n,[1,2,3,6,54,6*128**2,6*512**2][(n+q)%7],q)
for r in range(1,513):
    d=6*r*r
    for n,q in [(d*(1<<23)+d//2,-23),(d*((1<<23)+1)+d//2,-23),
                (d//2,-149),(3*d//2,-149),(d*((1<<24)-1)+d//2,-150+1),
                ((1<<95)-1,-149),((1<<95)-1,104)]:
        for sign in [-1,1]: pack(sign*n,d,q)
for _ in range(6000):
    bits=rng.randrange(1,128); n=rng.randrange(1<<bits)
    if rng.randrange(2):n=-n
    pack(n,rng.randrange(1,1572865),rng.randrange(-149,105))
for n in [-(1<<127),(1<<127)-1]:
    for d in [1,2,3,6,1572864]:
        for q in [-149,-126,-23,0,104]:pack(n,d,q)
for d,q in [(0,0),(1572865,0),(6,-150),(6,105)]:
    row('invalid-pack',0,limbs(3),[d,q&U32],[0,0,0,0])

anchors=[0,1,-1,(1<<31)-1,1<<32,(1<<32)+1,(1<<64)-1,1<<64,
         (1<<95)-1,-((1<<95)-1),(1<<127)-1,-(1<<127)]
for i in range(3500):
    a=anchors[i%len(anchors)] if i<300 else rng.getrandbits(128)
    b=anchors[(i//len(anchors))%len(anchors)] if i<300 else rng.getrandbits(128)
    row('add',1,limbs(a),limbs(b),limbs(a+b))
    row('sub',2,limbs(a),limbs(b),limbs(a-b))
    k=[-16383,-512,-1,0,1,512,16895][i%7]
    row('mul-i32',3,limbs(a),[k&U32],limbs(a*k))
    shift=[0,1,23,31,32,33,40,63,64,65,95,96,97,127,128,129][i%16]
    row('shift',4,limbs(a),[shift],limbs(a<<shift) if shift<128 else [0]*4)
for exponent in range(255):
    for mantissa in [0,1,(1<<23)-1]:
        for sign in [0,1]:
            bits=(sign<<31)|(exponent<<23)|mantissa
            for delta in [0,min(40,max(exponent,1)-1)]:
                minimum=max(exponent,1)-delta
                n=(mantissa+(1<<23 if exponent else 0))<<delta
                if sign:n=-n
                row('sample',5,limbs(bits),[minimum],limbs(n))

payload={'schema':'input16-u32/expected4-u32','seed':2026101103,'counts':counts,'rows':rows}
raw=json.dumps(payload,separators=(',',':')).encode(); (OUT/'helper-vectors.json').write_bytes(raw)
summary={'cases':len(rows),'counts':counts,'sha256':hashlib.sha256(raw).hexdigest(),'expected_source':'independent Python integers and Fraction.binary32; no shader execution'}
(OUT/'helper-vector-summary.json').write_text(json.dumps(summary,indent=2)+'\n'); print(json.dumps(summary))
