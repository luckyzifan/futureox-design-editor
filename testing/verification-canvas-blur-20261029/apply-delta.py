"""Apply/rollback this source delta only against every exact recorded preimage."""
from pathlib import Path
import argparse, hashlib, json, subprocess
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--reverse',action='store_true');p.add_argument('--check',action='store_true');args=p.parse_args()
record=Path(__file__).resolve().parent;root=Path(args.root).resolve(strict=True)
files=json.loads((record/'changes.json').read_text())['files']
def state(file):
    relative=Path(file)
    if relative.is_absolute() or '..' in relative.parts:raise SystemExit('Unsafe delta path')
    target=root/relative
    if not target.resolve().is_relative_to(root) or target.is_symlink():raise SystemExit('Delta path leaves target root')
    return hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
before='afterSha256' if args.reverse else 'beforeSha256';after='beforeSha256' if args.reverse else 'afterSha256'
for item in files:
    if state(item['path'])!=item[before]:raise SystemExit('Preimage mismatch: '+item['path'])
command=['git','apply',*(['--reverse'] if args.reverse else []),str(record/'task.patch')]
subprocess.run(command[:2]+['--check']+command[2:],cwd=root,check=True)
if not args.check:
    subprocess.run(command,cwd=root,check=True)
    for item in files:
        if state(item['path'])!=item[after]:raise SystemExit('Postimage mismatch: '+item['path'])
print(json.dumps({'status':'verified' if args.check else 'restored' if args.reverse else 'applied','files':len(files)}))
