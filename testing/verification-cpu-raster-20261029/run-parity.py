from pathlib import Path
import tempfile, shutil, subprocess, re
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
TMP=Path(tempfile.mkdtemp(prefix='cpu-raster-parity-'))
crate=ROOT/'design-studio/crates/design-kernel'
shutil.copytree(crate/'src',TMP/'baseline/src')
shutil.copytree(crate/'shaders',TMP/'baseline/shaders')
for src in (HERE/'before/src').rglob('*.rs'):
    dst=TMP/'baseline/src'/src.relative_to(HERE/'before/src');dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
manifest=(HERE/'before/Cargo.toml').read_text().replace('name = "futureox-design-kernel"','name = "futureox-design-kernel-baseline"').replace('["rlib", "cdylib"]','["rlib"]')
manifest=re.sub(r'\[\[bench\]\][\s\S]*?(?=\[|\Z)','',manifest)
(TMP/'baseline/Cargo.toml').write_text(manifest)
workspace=(ROOT/'design-studio/Cargo.toml').read_text()
workspace=re.sub(r'members = \[.*?\]','members = ["baseline", "probe"]',workspace)
workspace=workspace.replace('../vendor/',str(ROOT/'vendor')+'/')
(TMP/'Cargo.toml').write_text(workspace)
(TMP/'probe/src').mkdir(parents=True)
(TMP/'probe/Cargo.toml').write_text(f'''[package]
name="cpu-raster-parity-probe"
version="0.1.0"
edition="2024"
[dependencies]
candidate={{package="futureox-design-kernel",path="{crate}"}}
baseline={{package="futureox-design-kernel-baseline",path="../baseline"}}
serde_json.workspace=true
sha2.workspace=true
''')
shutil.copyfile(HERE/'renderer_parity.rs',TMP/'probe/src/main.rs')
print(TMP,flush=True)
result=subprocess.run(['cargo','run','--manifest-path',str(TMP/'Cargo.toml'),'-p','cpu-raster-parity-probe','--offline','-j','2','--target-dir',str(ROOT/'design-studio/target')])
raise SystemExit(result.returncode)
