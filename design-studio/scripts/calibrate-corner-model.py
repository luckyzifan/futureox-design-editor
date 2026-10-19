#!/usr/bin/env python3
"""Offline, bounded model-selection experiment on real Figma corner controls.

Compares the published cubic handle ratio, least squares, and Gaussian-process
Bayesian optimization on a fixed train/holdout split. This calibrates one shape
parameter, not a production rasterizer. No network/dataset upload or model is
used in rendering. See Snoek et al. (2012) for the BO framework.
"""
import argparse
import json
import math
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parents[2]

def cholesky(a):
    n=len(a);l=[[0.]*n for _ in a]
    for i in range(n):
        for j in range(i+1):
            v=a[i][j]-sum(l[i][k]*l[j][k] for k in range(j))
            l[i][j]=math.sqrt(max(v,1e-18)) if i==j else v/l[j][j]
    return l

def forward(l,b):
    x=[]
    for i,v in enumerate(b):x.append((v-sum(l[i][j]*x[j] for j in range(i)))/l[i][i])
    return x

def solve(l,b):
    y=forward(l,b);x=[0.]*len(y)
    for i in range(len(y)-1,-1,-1):x[i]=(y[i]-sum(l[j][i]*x[j] for j in range(i+1,len(y))))/l[i][i]
    return x

def experiment(reference):
    observations=[];excluded=[]
    for row in reference['rows']:
        t=row['frames'][1]['paths'][0]['data'].split()
        if len(t)<10 or t[0]!='M' or t[3]!='C':excluded.append(row['index']);continue
        p,c1,c2=(float(t[i]) for i in (2,5,7))
        if float(t[4])!=0 or float(t[6])!=0 or p<=c2:
            excluded.append(row['index']);continue
        observations.append({'index':row['index'],'span':p-c2,'observedRatio':(p-c1)/(p-c2)})
    train=[r for r in observations if r['index'] in [1,3,5,9,11]]
    holdout=[r for r in observations if r not in train]
    def loss(q,rows):return sum((q-r['observedRatio'])**2 for r in rows)/len(rows)
    qls=sum(r['observedRatio'] for r in train)/len(train)
    history=[{'ratio':q,'loss':loss(q,train)}for q in [.5,.65,.8]]
    kernel=lambda a,b:math.exp(-.5*((a-b)/.07)**2)
    started=time.perf_counter()
    for _ in range(12):
        xs=[p['ratio']for p in history];ys=[p['loss']for p in history]
        scale=max(max(ys),1e-10);ys=[v/scale for v in ys]
        l=cholesky([[kernel(a,b)+(1e-9 if i==j else 0)for j,b in enumerate(xs)]for i,a in enumerate(xs)])
        alpha=solve(l,ys);best=min(ys);choice=None
        for i in range(2049):
            q=.5+.35*i/2048
            if any(abs(q-x)<1e-10 for x in xs):continue
            k=[kernel(q,x)for x in xs];v=forward(l,k)
            mu=sum(a*b for a,b in zip(k,alpha));sigma=math.sqrt(max(1-sum(a*a for a in v),1e-16))
            z=(best-mu)/sigma
            ei=(best-mu)*(.5*(1+math.erf(z/math.sqrt(2))))+sigma*math.exp(-.5*z*z)/math.sqrt(2*math.pi)
            if choice is None or ei>choice[0]:choice=(ei,q)
        q=choice[1];history.append({'ratio':q,'loss':loss(q,train)})
    qbo=min(history,key=lambda r:r['loss'])['ratio']
    def evaluate(name,q,queries):
        return {'method':name,'ratio':q,'objectiveEvaluations':queries,
                'trainNormalizedRmse':math.sqrt(loss(q,train)),
                'holdoutNormalizedRmse':math.sqrt(loss(q,holdout)),
                'holdoutControlMaxError':max(abs(q-r['observedRatio'])*r['span']for r in holdout)}
    return {'parameter':'a/(a+b) of the straight-edge-to-arc cubic transition, conditioned on the observed endpoints; not a complete curve/raster model',
            'train':train,'holdout':holdout,
            'excludedFromThisParameterFit':{'indices':excluded,'reason':'No nondegenerate collinear transition in the flattened representation; still included in geometry/PNG tests.'},
            'results':[evaluate('published analytic 2:1 handle ratio',2/3,0),evaluate('one-parameter least squares',qls,1),evaluate('Gaussian-process expected-improvement optimization',qbo,len(history))],
            'bayesianHistory':history,'bayesianSearchSeconds':time.perf_counter()-started,
            'bayesianSettings':{'kernel':'RBF','lengthScale':.07,'jitter':1e-9,'parameterBounds':[.5,.85],'candidateGrid':2049,'iterations':12},
            'limits':['Small deterministic geometric calibration; not a neural-network benchmark.',
                      'Low geometric loss does not imply zero RGBA difference.',
                      'Training endpoints are held fixed; this does not learn unknown curve topology.',
                      'No learned weights are installed into product code.'],
            'sources':['https://proceedings.neurips.cc/paper/2012/hash/05311655a15b75fab86956663e1819cd-Abstract.html',
                       'https://www.figma.com/blog/desperately-seeking-squircles/',
                       'https://people.csail.mit.edu/tzumao/diffvg/']}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    reference=json.loads((ROOT/'testing/fixtures/design/figma-curves-2026-10-07.json').read_text())
    result=experiment(reference);args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['results'],indent=2))
