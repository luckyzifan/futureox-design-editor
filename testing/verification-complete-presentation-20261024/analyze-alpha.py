import collections, json, pathlib, sys
root = pathlib.Path(__file__).parent
for arg in sys.argv[1:]:
    run = root / arg
    report = json.loads((run / 'report.json').read_text())
    seen, rows = set(), []
    for log in [run / 'host.log', run / 'host-stdout.log']:
        if not log.exists(): continue
        for line in log.open():
            if '[render-diag] ' not in line: continue
            try: packet = json.loads(line.split('[render-diag] ',1)[1])
            except ValueError: continue
            for r in packet.get('batch', [packet]):
                key = (r.get('source'), r.get('session'), r.get('seq'))
                if key not in seen: rows.append(r); seen.add(key)
    def key(r, frame): return tuple(r.get(k) for k in ('deviceWorkerScope','deviceIncarnation','deviceOwner')) + (r.get(frame),)
    start, end = report.get('motionStart', 0), report.get('motionEnd', float('inf'))
    submits = [r for r in rows if r.get('event') == 'camera-submit' and start <= r.get('at', 0) <= end and r.get('compositorFrames')]
    probes = collections.defaultdict(list)
    for r in rows:
        if r.get('event') == 'frame-alpha' and r.get('alphaSubmitted') == 1: probes[key(r, 'alphaFrame')].append(r)
    bad, measured = [], []
    for r in submits:
        p = probes[key(r, 'compositorFrames')]
        if len(p) != 1: bad.append({'frame':key(r,'compositorFrames'), 'reason':'missing-or-duplicate', 'matches':len(p)}); continue
        p=p[0]; measured.append(p)
        if p.get('alphaProbeCode') != 0 or p.get('alphaPixelCount') != p.get('alphaWidth',0)*p.get('alphaHeight',0):
            bad.append({'frame':key(r,'compositorFrames'),'reason':'invalid-probe','probe':p})
        if p.get('alphaZeroPixels', 0): bad.append({'frame':key(r,'compositorFrames'),'reason':'transparent-content-pixels','probe':p})
    result = {'scope':'actual content texture per submitted logical frame; these fixtures have an opaque canvas background; no physical scanout or timing claim',
        'status':'passed' if submits and not bad else 'failed', 'submittedFrames':len(submits), 'measuredFrames':len(measured),
        'deferredFrames':sum(r.get('coverageDeferred')==1 and start<=r.get('at',0)<=end for r in rows),
        'minAlpha':min((r.get('alphaMinimum',0) for r in measured),default=None),
        'maximumZeroPixels':max((r.get('alphaZeroPixels',0) for r in measured),default=None), 'failures':bad}
    run.with_name(run.name+'-alpha.json').write_text(json.dumps(result,indent=2))
    print(arg,{k:v for k,v in result.items() if k not in ('scope','failures')},'failures',len(bad))
