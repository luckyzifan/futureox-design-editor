import json, sys, pathlib, collections
out = pathlib.Path(__file__).parent
for arg in sys.argv[1:]:
    run = pathlib.Path(arg)
    if not run.is_absolute(): run = out / run
    report_path = run / 'report.json' if (run / 'report.json').exists() else run.with_suffix('.json')
    report = json.loads(report_path.read_text()); seen = set(); all_rows = []
    for log in [run / 'host.log', run / 'host-stdout.log']:
        if not log.exists(): continue
        for line in log.open():
            if '[render-diag] ' not in line: continue
            try: batch = json.loads(line.split('[render-diag] ', 1)[1])
            except (ValueError, IndexError): continue
            for row in batch.get('batch', [batch]):
                key = (row.get('source'), row.get('session'), row.get('seq'))
                if key not in seen: seen.add(key); all_rows.append(row)
    start, end = report.get('motionStart', 0), report.get('motionEnd', 1e16)
    rows = sorted((r for r in all_rows if start <= r.get('at', 0) <= end), key=lambda r: r['at'])
    submits = [r for r in rows if r.get('event') == 'camera-submit' and r.get('coverageMeasured') == 1]
    tiles = [r for r in rows if r.get('event') == 'tile' and r.get('outputPixelVisits')]
    inputs = [r for r in rows if r.get('event') == 'camera-input']
    rejects = [r for r in rows if r.get('surfaceRejected')]
    complete = [r for r in rows if r.get('event') == 'viewport-state' and r.get('finalComplete') == 1]
    last_input = inputs[-1]['at'] if inputs else None
    first_complete = next((r['at'] for r in complete if last_input is not None and r['at'] >= last_input), None)
    result = {'run': str(run), 'scope': 'real compositor diagnostics; queue submission is not physical scanout, motion input includes UI and native wheel; no global G2/G5 acceptance',
        'reportStatus': report.get('status'), 'windowMs': end - start, 'cameraSubmits': len(submits),
        'nonSharpSubmits': sum(r.get('sharpCoverage', 0) < 1 for r in submits),
        'nonNativePhaseSubmits': sum(r.get('nativePhaseCoverage', 0) < 1 for r in submits),
        'minCoverage': min((r.get('coverage', 0) for r in submits), default=None),
        'maxUpscale': max((r.get('maxUpscale', 0) for r in submits), default=None),
        # In these fixed 855x836/DPR2 runs a foreground request has a positive
        # replacement reserve. Use the actual sanitized wire field; a missing
        # field is unknown, not evidence that the rejection was optional.
        'surfaceRejects': len(rejects), 'foregroundRejects': sum(r.get('surfaceReserveBytes', 0) > 0 for r in rejects),
        'zeroReserveRejects': sum(r.get('surfaceReserveBytes') == 0 for r in rejects),
        'unclassifiedRejects': sum('surfaceReserveBytes' not in r for r in rejects),
        'maxPipelineMs': max((r.get('pipelineWallMs', 0) for r in rows), default=0),
        'maxTileMs': max((r.get('milliseconds', 0) for r in tiles), default=0),
        'maxWorkingBytes': max((r.get('workingTextureBytes', 0) for r in rows), default=0),
        'maxPassAmplification': max((r['encodedPassPixels']/r['outputPixelVisits'] for r in tiles if r.get('encodedPassPixels')), default=0),
        'nativeWheelInputs': len(inputs), 'lastWheelToFirstCompleteMs': first_complete - last_input if first_complete is not None else None,
        'dispatchStoppedToConvergenceMs': report.get('motionEnd', 0) - report['inputStopped'] if 'inputStopped' in report else None,
        'lastReceiptAfterDispatchStoppedMs': report.get('inputs', [{}])[-1].get('at', 0) - report['inputStopped'] if report.get('inputs') and 'inputStopped' in report else None,
        'finalCompleteObservations': len(complete), 'errors': report.get('errors', report.get('error')),
        'checks': report.get('checks'), 'submitSamples': submits}
    run.with_name(run.name + '-quality.json').write_text(json.dumps(result, indent=2))
    print({k:v for k,v in result.items() if k not in ['scope', 'submitSamples', 'checks']})
