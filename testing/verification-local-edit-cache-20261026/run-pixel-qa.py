"""Sequential, isolated real-file checks; never run performance beside builds."""
import json, os, pathlib, subprocess, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).resolve().parent
runtime = json.loads((OUT / 'runtime.json').read_text())
candidate = json.loads((OUT / 'candidate.json').read_text())['host']
cases = {
    'fig': {'LOCAL_PATH': '7.1.0.1'},
    '117': {'LOCAL_NODE': 'D72F942F-283C-4C72-91F3-900DF45D64F2', 'LOCAL_SHOW_HIDDEN': '1'},
    'sketch': {'LOCAL_NODE': '8BFE928D-991B-4534-88F0-D335E5BD6246', 'SOURCE_CASE': '1:5'},
}
plan = [('fig', 1), ('117', 1), ('sketch', 1)]
records = []
for kind, repeat in plan:
    for variant, host in [('a', runtime['host']), ('b', candidate)]:
        quiet = 0
        for attempt in range(180):
            names = subprocess.check_output(['ps', '-axo', 'comm='], text=True).splitlines()
            busy = any(pathlib.Path(name.strip()).name in ('cargo', 'rustc') for name in names)
            quiet = 0 if busy else quiet + 1
            if quiet >= 3:
                break
            time.sleep(2)
        else:
            raise RuntimeError('Compiler contention did not settle')
        name = f'pixels-{kind}-{repeat}-{variant}'
        env = {**os.environ, **cases[kind], 'DRAG_HOST': host}
        command = ['node', str(OUT / 'pixel-qa.mjs'), kind, name]
        started = time.time()
        with (OUT / (name + '.log')).open('w') as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        row = {'kind': kind, 'repeat': repeat, 'variant': variant, 'run': name,
               'command': command, 'start': started, 'end': time.time(), 'exitCode': result.returncode}
        records.append(row)
        (OUT / 'pixel-qa-runs.json').write_text(json.dumps(records, indent=2))
        subprocess.run(['node', str(OUT / 'analyze-local.mjs'), str(OUT / name)], cwd=ROOT, check=True)
        print(name, result.returncode, flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
