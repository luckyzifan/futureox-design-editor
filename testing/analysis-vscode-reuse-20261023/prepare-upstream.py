"""Fetch only the pinned research modules into a new scratch directory.
Then install isolated tooling using the saved package manifests and npm ci.
"""
import hashlib,json,pathlib,sys,urllib.request,shutil
here=pathlib.Path(__file__).resolve().parent
out=pathlib.Path(sys.argv[1]).resolve()
if out.exists() and any(out.iterdir()):raise SystemExit('Choose a new or empty scratch directory')
out.mkdir(parents=True,exist_ok=True)
manifest=json.loads((here/'upstream.json').read_text())
for item in manifest['files']:
    p=item['path'];raw=urllib.request.urlopen(f"https://raw.githubusercontent.com/microsoft/vscode/{manifest['commit']}/{p}",timeout=30).read()
    actual=hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()
    if actual!=item['blobSha']:raise ValueError(f'Git blob hash mismatch: {p}')
    target=out/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
tooling=out/'tooling';tooling.mkdir()
for f in ['package.json','package-lock.json']:shutil.copy2(here/('tooling-'+f),tooling/f)
print(json.dumps({'scratch':str(out),'upstream':manifest['commit'],'files':len(manifest['files'])}))
