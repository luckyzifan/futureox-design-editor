#!/usr/bin/env python3
"""Run the checked workspace tests offline, preserving skips and real failures."""
from __future__ import annotations

import datetime
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
WORKSPACE = REPO / "design-studio"
COMMAND = ["cargo", "test", "--workspace", "--locked", "--offline"]


def identity():
    roots = ["design-studio", "vendor/moxcms", "rust-toolchain.toml", ".cargo/config.toml",
             "testing/fixtures", "frontend/design-client/public/fonts",
             "frontend/design-client/public/fidelity"]
    paths = subprocess.check_output(["git", "ls-files", "-z", "--", *roots], cwd=REPO).decode().split("\0")
    values = {p: hashlib.file_digest((REPO / p).open("rb"), "sha256").hexdigest()
              for p in sorted(set(paths)) if p and (REPO / p).is_file()}
    return {"scope": "Tracked Rust workspace/toolchain/lock/config, patched vendor, and checked-in test fixtures/fonts/fidelity references; excludes unrelated TypeScript renderer changes",
            "sha256": hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest(),
            "files": values}


env = {k: v for k, v in os.environ.items() if not k.startswith("FUTUREOX_DESIGN_") and k not in (
    "DESIGN_API_TOKEN", "DESIGN_DATABASE_URL", "DATABASE_URL", "SKETCH_RESOURCE_EVIDENCE",
    "SKETCH_FONT_EVIDENCE", "DESIGN_GPU_TEST_ARTIFACTS", "RUSTUP_TOOLCHAIN")}
env["TMPDIR"] = os.path.realpath(tempfile.gettempdir())
before = identity()
summary = {
    "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
    "command": " ".join(COMMAND), "cwd": "design-studio",
    "cargo": subprocess.check_output(["cargo", "--version"], cwd=WORKSPACE, env=env, text=True).strip(),
    "rustc": subprocess.check_output(["rustc", "--version"], cwd=WORKSPACE, env=env, text=True).strip(),
    "sourceBefore": before, "features": "workspace defaults; hardware-tests not enabled",
    "boundary": "Real Rust workspace tests, owned subprocesses/temporary SQLite and CPU rendering. Ignored hardware/large benchmarks are not acceptance; no external service or database is supplied.",
    "log": "rust-workspace.log", "gates": [],
}
sample = env.get("SKETCH_FONT_SAMPLE_FD")
summary["optionalFontSample"] = {"provided": bool(sample), "exists": bool(sample and Path(sample).is_file())}
if not sample:
    summary["nominalPassWithoutFixture"] = [{
        "test": "actual_mcp_sample_noto_roundtrip",
        "source": "design-studio/crates/design-kernel/tests/sketch_font_resources.rs:212",
        "reason": "Existing test returns early when SKETCH_FONT_SAMPLE_FD is absent; its nominal Cargo pass is not counted as executed fixture acceptance",
    }]
else:
    summary["nominalPassWithoutFixture"] = []

began = time.monotonic()
rows = []
with (HERE / summary["log"]).open("w") as log:
    child = subprocess.Popen(COMMAND, cwd=WORKSPACE, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, bufsize=1)
    print(json.dumps({"status": "running", "command": summary["command"],
                      "sourceSha256": before["sha256"]}), flush=True)
    for line in child.stdout:
        line = re.sub(r"(?:postgres(?:ql)?|https?)://[^\s]+", "[external-url-redacted]", line)
        log.write(line)
        log.flush()
        rows.append(line)
        if "test result:" in line or "error:" in line or "FAILED" in line:
            print(line.rstrip(), flush=True)
    exit_code = child.wait()

text = "".join(rows)
counts = {k: 0 for k in ("passed", "failed", "ignored", "measured", "filteredOut")}
suite_results = []
for match in re.finditer(r"test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out", text):
    row = dict(zip(counts, map(int, match.groups()[1:])))
    suite_results.append({"status": match.group(1), **row})
    for key, value in row.items():
        counts[key] += value
after = identity()
summary.update({"exitCode": exit_code, "wallSeconds": round(time.monotonic() - began, 3),
                "counts": counts, "testResultGroups": suite_results,
                "ignoredTests": re.findall(r"^test (.+?) \.\.\. ignored(?:, (.*))?$", text, re.MULTILINE),
                "sourceAfter": after, "sourceStable": before == after,
                "actualGpuAdapter": None,
                "finishedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
nominal = len(summary["nominalPassWithoutFixture"])
summary["acceptedExecutedPasses"] = max(0, counts["passed"] - nominal)
summary["passed"] = exit_code == 0 and counts["failed"] == 0 and before == after
(HERE / "rust-regression-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({k: summary[k] for k in ("exitCode", "wallSeconds", "counts", "acceptedExecutedPasses", "sourceStable", "passed")}), flush=True)
raise SystemExit(0 if summary["passed"] else 1)
