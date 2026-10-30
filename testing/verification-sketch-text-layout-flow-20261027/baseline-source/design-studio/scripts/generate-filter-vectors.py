#!/usr/bin/env python3
"""Independent rational integration/oracle for single-round tent filtering."""
import argparse
from fractions import Fraction as Q
import importlib.util
import json
import math
from pathlib import Path
import random
import struct

ROOT=Path(__file__).resolve().parents[2]
DEST=ROOT/'testing/fixtures/design/filter-vectors.json'
spec=importlib.util.spec_from_file_location('rounding',Path(__file__).with_name('generate-precision-vectors.py'))
rounding=importlib.util.module_from_spec(spec);spec.loader.exec_module(rounding)

def integrate(radius,distance):
    d=Q(distance);cuts=sorted({-radius,Q(0),radius,d-1,d,d+1});result=Q(0)
    for lo,hi in zip(cuts,cuts[1:]):
        mid=(lo+hi)/2
        if abs(mid)>=radius or abs(mid-d)>=1:continue
        a=1/radius;b=Q(1 if mid<0 else -1)/(radius*radius)
        c=1-d if mid<d else 1+d;e=Q(1 if mid<d else -1)
        result+=a*c*(hi-lo)+(a*e+b*c)*(hi**2-lo**2)/2+b*e*(hi**3-lo**3)/3
    return result

def corpus():
    rng=random.Random(202610071)
    radii=[math.ulp(0.),1e-300,2.**-150,2.**-60,0.1,0.125,0.25,0.5,
           math.nextafter(1.,0.),1.,math.nextafter(1.,2.),1.1,2.5,3.,4.25,8.,32.,511.125,512.]
    radii += [rng.randrange(1,4096)/512 for _ in range(48)]
    cases=[]
    extremes=[0,0x80000000,1,0x80000001,0x800000,0x80800000,
              0x3f800000,0xbf800000,0x7f7fffff,0xff7fffff,0x4083f34d,0xbe4ccccd]
    for radius in radii:
        reach=math.ceil(radius);r=Q.from_float(radius)
        side=[integrate(r,i) for i in range(reach+1)];weights=[side[abs(i)]for i in range(-reach,reach+1)]
        assert sum(weights)==1 and min(weights)>=0
        den=math.lcm(*(w.denominator for w in side));nums=[int(w*den) for w in side]
        for kind in range(8):
            if kind<3:values=[extremes[[0,8,11][kind]]]*(2*reach+1)
            elif kind==3:values=[extremes[i%len(extremes)]for i in range(2*reach+1)]
            elif kind==4:
                values=[0]*(2*reach+1);values[reach]=1;values[0]=0x7f7fffff;values[-1]=0xff7fffff
            else:values=[rng.randrange(0x7f800000)|(rng.randrange(2)<<31)for _ in range(2*reach+1)]
            result=sum(w*rounding.exact(v)for w,v in zip(weights,values))
            cases.append({'kind':'tent','radiusBits':struct.pack('>d',radius).hex(),'numerators':[str(n)for n in nums],
                          'denominator':str(den),'values':values,'expected':rounding.binary32(result)})
    for radius in [0,1,2,3,7,16,127,256,512]:
        for kind in range(12):
            size=2*radius+1
            if kind==0:values=[0]*size
            elif kind==1:values=[0x7f7fffff]*size
            elif kind==2:values=[extremes[i%len(extremes)]for i in range(size)]
            elif kind==3:values=[0x3f800000+(i%2)for i in range(size)]
            else:values=[rng.randrange(0x7f800000)|(rng.randrange(2)<<31)for _ in range(size)]
            result=sum(rounding.exact(v)for v in values)/size
            cases.append({'kind':'box','radiusBits':struct.pack('>d',float(radius)).hex(),
                          'numerators':['1']*(radius+1),'denominator':str(size),
                          'values':values,'expected':rounding.binary32(result)})
    return {'contract':'Exact integral tent coefficients at finite binary64 r in (0,512] or uniform boxes at integer r in [0,512], exact products/sum, one binary32 RNE; exact zero +0, signed underflow retained','cases':cases}

def gaussian_corpus():
    rng=random.Random(202610073);cases=[]
    for sigma in [0.,.099,0.1,.5,1.,1.25,1.5,2.,4.25,12.125,128.]:
        width,height=9,7
        values=[rng.randrange(1,0x3f800001)for _ in range(width*height*4)]
        values[0:4]=[0x3f800000,0x3f000000,0x34000000,0x3f800000]
        ideal=math.sqrt(4*sigma*sigma+1);lower=max(1,math.floor(ideal));lower-=int(lower%2==0);upper=lower+2
        m=max(0,min(3,math.floor((12*sigma*sigma-3*lower*lower-12*lower-9)/(-4*lower-4)+.5)))
        radii=[(lower-1 if i<m else upper-1)//2 for i in range(3)] if sigma>=.1 else [0]*3
        current=list(values)
        for radius in radii:
            if radius==0:continue
            for horizontal in [True,False]:
                out=[]
                for y in range(height):
                    for x in range(width):
                        for c in range(4):
                            terms=[]
                            for d in range(-radius,radius+1):
                                sx,sy=(x+d,y)if horizontal else(x,y+d)
                                if 0<=sx<width and 0<=sy<height:terms.append(rounding.exact(current[(sy*width+sx)*4+c]))
                            v=max(Q(0),min(Q(1),sum(terms,Q(0))/(2*radius+1)))
                            out.append(rounding.binary32(v))
                current=out
        cases.append({'sigma':sigma,'radii':radii,'width':width,'height':height,'input':values,'expected':current})
    return {'contract':'Independent Fraction convolution for each separable uniform-box stage; one binary32 RNE and [0,1] clamp at each stage, transparent boundaries','cases':cases}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--check',action='store_true');args=p.parse_args()
    data=json.dumps(corpus(),separators=(',',':'))+'\n'
    if args.check:
        if DEST.read_text()!=data:raise SystemExit('Rational filter oracle is stale')
    else:DEST.write_text(data)
    gaussian=json.dumps(gaussian_corpus(),separators=(',',':'))+'\n'
    destination=ROOT/'testing/fixtures/design/gaussian-vectors.json'
    if args.check:
        if destination.read_text()!=gaussian:raise SystemExit('Gaussian oracle is stale')
    else:destination.write_text(gaussian)
    print(len(json.loads(data)['cases']),'exact rational filter vectors;',len(json.loads(gaussian)['cases']),'independent Gaussian surfaces')
