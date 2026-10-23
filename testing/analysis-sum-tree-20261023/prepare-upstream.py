"""Build an isolated workspace; retain exact upstream Rust sources and narrow manifests.
Usage: python3 prepare-upstream.py /absolute/scratch/path
No product Cargo.toml, lockfile, or generated WASM is changed.
"""
import hashlib, json, pathlib, sys, urllib.request
SHA='cfb894a5dde8ccf3fba1659164f47fdd1c024e2e'
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
files=['crates/sum_tree/src/sum_tree.rs','crates/sum_tree/src/cursor.rs','crates/sum_tree/src/tree_map.rs',
       'crates/ztracing/src/lib.rs','crates/ztracing_macro/src/lib.rs','LICENSE-APACHE']
meta={'commit':SHA,'source_modifications':False,'manifest_changes':'isolated no-feature production dependencies only; upstream development/test dependencies excluded','files':{}}
for f in files:
    raw=urllib.request.urlopen(f'https://raw.githubusercontent.com/zed-industries/zed/{SHA}/{f}',timeout=30).read()
    path=out/f;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
    meta['files'][f]=hashlib.sha256(raw).hexdigest()
(out/'Cargo.toml').write_text('''[workspace]
members = ["crates/sum_tree", "crates/ztracing", "crates/ztracing_macro"]
resolver = "2"
[package]
name = "sum-tree-probe"
version = "0.1.0"
edition = "2024"
publish = false
[[bin]]
name = "sum-tree-probe"
path = "bench-native.rs"
[dependencies]
sum_tree = { path = "crates/sum_tree" }
im = "15.1"
[profile.release]
lto = "thin"
codegen-units = 1
''')
(out/'crates/sum_tree/Cargo.toml').write_text('''[package]
name = "sum_tree"
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"
[lib]
path = "src/sum_tree.rs"
[dependencies]
heapless = "=0.9.2"
rayon = "1.8"
tracing = "0.1.40"
ztracing = { path = "../ztracing" }
[features]
test-support = []
''')
(out/'crates/ztracing/Cargo.toml').write_text('''[package]
name = "ztracing"
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"
[dependencies]
tracing = "0.1.40"
ztracing_macro = { path = "../ztracing_macro" }
[features]
web = []
[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(ztracing)', 'cfg(ztracing_with_memory)'] }
''')
(out/'crates/ztracing_macro/Cargo.toml').write_text('''[package]
name = "ztracing_macro"
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"
[lib]
proc-macro = true
''')
(out/'bench-native.rs').write_text((pathlib.Path(__file__).parent/'bench-native.rs').read_text())
(out/'upstream.json').write_text(json.dumps(meta,indent=2))
print(json.dumps({'workspace':str(out),'commit':SHA}))
