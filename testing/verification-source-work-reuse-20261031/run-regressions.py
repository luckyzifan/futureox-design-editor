from pathlib import Path
import os, subprocess, json, time

out = Path(__file__).resolve().parent
root = out.parent.parent
env = dict(os.environ, CARGO_BUILD_JOBS='2')
cases = [
    ('backend-tests-final', 'futureox-design-desktop-backend', 'large_document'),
    ('preparation-tests', 'futureox-design-kernel', 'preparation'),
    ('source-compile-tests', 'futureox-design-kernel', 'source_compile'),
]
results = []
for name, package, scope in cases:
    command = ['cargo', 'test', '--locked', '--manifest-path', 'design-studio/Cargo.toml', '-p', package, scope, '--lib']
    start = time.monotonic()
    with (out / (name + '.log')).open('w') as log:
        run = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    record = {'case': name, 'command': command, 'exit_code': run.returncode, 'seconds': time.monotonic()-start}
    results.append(record)
    (out / 'regressions.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(record), flush=True)
    if run.returncode: raise SystemExit(run.returncode)
