"""Recover symbols only after proving exact executable WASM identity."""
import importlib.util
import json
import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("buildweb", ROOT / "design-studio/scripts/build-web.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="render-profile-symbols-") as directory:
    subprocess.run([shutil.which("wasm-bindgen"), str(ROOT / "design-studio/target/wasm32-unknown-unknown/release/futureox_design_kernel.wasm"), "--target", "web", "--out-dir", directory, "--out-name", "design_kernel"], check=True)
    raw = (Path(directory) / "design_kernel_bg.wasm").read_bytes()
    actual = (ROOT / "frontend/design-client/public/kernel/design_kernel_bg.wasm").read_bytes()
    if module.strip_names(raw) != actual:
        raise ValueError("WASM executable bytes differ; refusing stale symbols")
    symbols = {}
    position = 8
    while position < len(raw):
        kind = raw[position]
        length, start = module._uleb(raw, position + 1)
        end = start + length
        if kind == 0:
            size, text = module._uleb(raw, start)
            if raw[text:text + size] == b"name":
                offset = text + size
                while offset < end:
                    subtype = raw[offset]
                    size, body = module._uleb(raw, offset + 1)
                    limit = body + size
                    if subtype == 1:
                        count, cursor = module._uleb(raw, body)
                        for _ in range(count):
                            index, cursor = module._uleb(raw, cursor)
                            size, cursor = module._uleb(raw, cursor)
                            symbols[index] = raw[cursor:cursor + size].decode()
                            cursor += size
                    offset = limit
        position = end
    (OUT / "wasm-names.json").write_text(json.dumps(symbols))
    identity = {"method": "wasm-bindgen same release input; remove optional name section and compare executable bytes", "equalExecutableBytes": True, "productionSha256": hashlib.sha256(actual).hexdigest(), "namedSha256": hashlib.sha256(raw).hexdigest(), "namedFunctions": len(symbols)}
    (OUT / "wasm-symbol-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    print(json.dumps(identity))
