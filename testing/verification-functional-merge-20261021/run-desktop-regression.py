#!/usr/bin/env python3
"""Desktop Node and existing native-preparation regression; no build or GUI."""
from __future__ import annotations

import datetime
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DESKTOP = REPO / "frontend/design-desktop"
ZIP_PATHS = json.loads((HERE / "historical-manifest.json").read_text())["changedPaths"]
parser = argparse.ArgumentParser()
parser.add_argument("--label", default="final")
options = parser.parse_args()
if not re.fullmatch(r"[a-z0-9-]{1,40}", options.label):
    parser.error("label must use 1–40 lowercase letters, digits or hyphens")


def digest(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def identity():
    tracked = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "frontend/design-desktop"], cwd=REPO
    ).decode().split("\0")
    paths = sorted(set([p for p in tracked if p] + [x["path"] for x in ZIP_PATHS]))
    # Include a new helper before Git staging, plus ignored working-tree inputs
    # that source-copy tests can observe. Empty retired directories matter too.
    actual = [p for name in ("src", "scripts", "test") for p in (DESKTOP / name).rglob("*")]
    paths = sorted(set(paths + [str(p.relative_to(REPO)) for p in actual if p.is_file()]))
    values = {p: digest(REPO / p) if (REPO / p).is_file() else None for p in paths}
    directories = sorted(str(p.relative_to(REPO)) for p in actual if p.is_dir())
    return {"scope": "Desktop tracked inputs plus actual src/scripts/test files and directories, and all 123 imported ZIP target paths; excludes unrelated kernel renderer edits",
            "sha256": hashlib.sha256(json.dumps({"files": values, "directories": directories}, sort_keys=True).encode()).hexdigest(),
            "files": values, "directories": directories}


def redacted(text):
    text = text.replace("ephemeral-test-token-1234567890", "[fixture-token]")
    text = re.sub(r"(?:/[^\s'\"\]\[,)]+)+\.sock", "[fixture-socket]", text)
    text = re.sub(r"([\"']?(?:token|bridgeToken|FUTUREOX_DESIGN_BRIDGE_TOKEN)[\"']?\s*[:=]\s*)[\"']?[^\s,}\"']+[\"']?",
                  r"\1[redacted]", text, flags=re.IGNORECASE)
    return text


env = {key: value for key, value in os.environ.items()
       if not key.startswith("FUTUREOX_DESIGN_") and key not in (
           "FUTUREOX_BACKEND_TEST_BINARY", "CORE_DESKTOP_TEST_SOURCE", "CORE_DESKTOP_SIDECAR",
           "DESIGN_PREPARE_BINARY", "DESIGN_WASM_BINDINGS")}
env["TMPDIR"] = os.path.realpath(tempfile.gettempdir())
backend = REPO / "design-studio/target/release/futureox-design-desktop-backend"
prepare = REPO / "design-studio/target/release/design-prepare"
bindings = REPO / "frontend/design-client/src/generated/design-kernel"
wasm = REPO / "frontend/design-client/public/kernel/design_kernel_bg.wasm"
font = REPO / "frontend/design-client/public/fonts/NotoSansSC.ttf"
runtime_files = [backend, prepare, bindings / "design_kernel.js", wasm, font]


def runtime_identity():
    return {str(p.relative_to(REPO)): {"exists": p.is_file(),
            "sha256": digest(p) if p.is_file() else None,
            "bytes": p.stat().st_size if p.is_file() else None}
            for p in runtime_files}


if backend.is_file() and os.access(backend, os.X_OK):
    env["FUTUREOX_BACKEND_TEST_BINARY"] = str(backend)
if prepare.is_file() and os.access(prepare, os.X_OK):
    env["DESIGN_PREPARE_BINARY"] = str(prepare)

before = identity()
runtime_before = runtime_identity()
summary = {
    "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
    "node": subprocess.check_output(["node", "--version"], env=env, text=True).strip(),
    "sourceBefore": before, "runtimeBefore": runtime_before,
    "runtimeProvenance": "Existing release native binaries and generated WASM; no rebuild performed. Runtime tests compare actual native/WASM outputs rather than asserting build freshness.",
    "temporaryPathPolicy": "canonical path of the same OS temporary directory",
    "initialAttempt": "desktop-initial-attempt-summary.json" if (HERE / "desktop-initial-attempt-summary.json").exists() else None,
    "backendAvailable": "FUTUREOX_BACKEND_TEST_BINARY" in env,
    "boundary": "npm test: desktop Node contracts, mocks, real owned sockets/subprocesses, and real SQLite only when the existing sidecar is admitted. test:preparation: actual native preparation versus existing WASM. No Electron GUI, GPU, build or Rust test suite.",
    "gates": [],
}
failed = False
for label, args in (
    ("desktop-node-tests", ["npm", "test"]),
    ("desktop-preparation-runtime", ["npm", "run", "test:preparation"]),
):
    if label == "desktop-preparation-runtime" and not all(p.is_file() for p in (prepare, bindings / "design_kernel.js", wasm, font)):
        summary["gates"].append({"name": label, "command": " ".join(args),
                                  "status": "blocked", "reason": "Actual native preparation/WASM/font runtime unavailable; no substitute created"})
        failed = True
        continue
    began = time.monotonic()
    result = subprocess.run(args, cwd=DESKTOP, env=env, capture_output=True, text=True)
    output = redacted(result.stdout + result.stderr)
    log = f"{label}-{options.label}.log"
    (HERE / log).write_text(output)
    counts = {key: int(matches[-1]) for key in (
        "tests", "suites", "pass", "fail", "cancelled", "skipped", "todo")
        if (matches := re.findall(rf"^(?:#|ℹ) {key} (\d+)\s*$", output, flags=re.MULTILINE))}
    entry = {"name": label, "command": " ".join(args), "cwd": "frontend/design-desktop",
             "exitCode": result.returncode, "wallSeconds": round(time.monotonic() - began, 3),
             "counts": counts, "log": log}
    summary["gates"].append(entry)
    failed = failed or result.returncode != 0 or counts.get("fail", 0) != 0 or counts.get("cancelled", 0) != 0 or not counts.get("tests")
    print(json.dumps(entry), flush=True)

after = identity()
runtime_after = runtime_identity()
summary.update({"sourceAfter": after, "sourceStable": before == after,
                "runtimeAfter": runtime_after, "runtimeStable": runtime_before == runtime_after,
                "finishedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
failed = failed or before != after or runtime_before != runtime_after
summary["passed"] = not failed
(HERE / "desktop-regression-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
raise SystemExit(1 if failed else 0)
