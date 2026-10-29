"""Create a disposable validation entry without changing production IPC policy."""
from pathlib import Path
import subprocess,shutil,json,hashlib,sys
version=sys.argv[1]
if not version.startswith('v') or not version[1:].isdigit(): raise ValueError('Expected vN')
base=Path.cwd()/'frontend/design-desktop';build=Path('/tmp')/f'futureox-topology-20261027-native-canvas-{version}';lab=Path('/tmp')/f'futureox-native-canvas-{version}-lab-dist';host=Path('/tmp')/f'futureox-native-canvas-{version}-host-20261027'
assert (build/'native-source-check-manifest.json').is_file();assert not lab.exists() and not host.exists()
lab.mkdir();subprocess.run(['cp','-cR',str(build/'renderer'),str(lab/'renderer')],check=True)
for name in ['bin','sidecar','fonts']:(lab/name).symlink_to(build/name)
source=(lab/'renderer/native-source-check.html').read_bytes();(lab/'renderer/index.html').write_bytes(source)
host.mkdir();shutil.copytree(base/'src',host/'src');shutil.copy2(base/'package.json',host/'package.json');(host/'assets').symlink_to(base/'assets');(host/'dist').symlink_to(lab)
p=host/'src/render-check.mjs';text=p.read_text();assert "source: 'native-source-check.html'" in text;text=text.replace("source: 'native-source-check.html'","source: 'index.html'");p.write_text(text)
(lab/'entry-manifest.json').write_text(json.dumps({'baseBuild':str(build),'entry':'index.html','entrySource':'native-source-check.html','entrySha256':hashlib.sha256(source).hexdigest(),'copiedHostEntrySha256':hashlib.sha256(text.encode()).hexdigest(),'hostSecurity':'unchanged production APP_URL sender checks'},indent=2))
print(host)
