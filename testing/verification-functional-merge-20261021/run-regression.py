#!/usr/bin/env python3
"""Run only the local MCP syntax/unit/socket gates, with scoped source identity.

No user bridge is contacted: integration owns a temporary fixture socket. Never
copy live bridge environment values or raw connection details into evidence.
"""
from __future__ import annotations

import datetime
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MCP = REPO / "frontend/design-mcp"
parser = argparse.ArgumentParser()
parser.add_argument("--canonical-temp", action="store_true",
                    help="Use the existing OS temporary directory's real path; keep production symlink rejection intact")
options = parser.parse_args()


def identity():
    files = [MCP / "package.json"]
    files += [p for folder in ("src", "test") for p in (MCP / folder).rglob("*")
              if p.is_file() and p.suffix in (".mjs", ".mts")]
    values = {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(files)}
    digest = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    return {"sha256": digest, "files": values}


def redacted(text):
    # The test uses this fixed credential; no live token is admitted to the child.
    text = text.replace("ephemeral-test-token-1234567890", "[fixture-token]")
    text = re.sub(r"(?:/[^\s'\"\]\[,)]+)+\.sock", "[fixture-socket]", text)
    text = re.sub(r"FUTUREOX_DESIGN_BRIDGE_TOKEN\s*[=:]\s*[^\s,}]+",
                  "FUTUREOX_DESIGN_BRIDGE_TOKEN=[redacted]", text)
    return text


before = identity()
env = {key: value for key, value in os.environ.items()
       if not key.startswith("FUTUREOX_DESIGN_") and key not in (
           "MCP_OFFICIAL_SDK_ROOT", "MCP_EVIDENCE_DIR")}
if options.canonical_temp:
    env["TMPDIR"] = os.path.realpath(tempfile.gettempdir())
summary = {
    "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
    "node": subprocess.check_output(["node", "--version"], env=env, text=True).strip(),
    "boundary": "Production MCP adapter; unit/stream/subprocess tests and real local Unix socket/CLI against deterministic bridge fixture. No Electron, real Editor/SQLite, official SDK or external service.",
    "sourceBefore": before,
    "temporaryPathPolicy": "canonical path of the same OS temporary directory" if options.canonical_temp else "inherited OS temporary directory",
    "initialAttempt": "initial-attempt-summary.json" if (HERE / "initial-attempt-summary.json").exists() else None,
    "gates": [],
}
failed = False
for label, args in (
    ("mcp-check", ["npm", "run", "check"]),
    ("mcp-tests", ["npm", "test"]),
    ("mcp-socket-integration", ["npm", "run", "test:integration"]),
):
    began = time.monotonic()
    result = subprocess.run(args, cwd=MCP, env=env, capture_output=True, text=True)
    output = redacted(result.stdout + result.stderr)
    log = f"{label}{'-canonical-temp' if options.canonical_temp else ''}.log"
    (HERE / log).write_text(output)
    counts = {key: int(matches[-1]) for key in (
        "tests", "suites", "pass", "fail", "cancelled", "skipped", "todo")
        if (matches := re.findall(rf"^(?:#|ℹ) {key} (\d+)\s*$", output, flags=re.MULTILINE))}
    entry = {"name": label, "command": " ".join(args),
             "cwd": "frontend/design-mcp", "exitCode": result.returncode,
             "wallSeconds": round(time.monotonic() - began, 3),
             "counts": counts, "log": log}
    summary["gates"].append(entry)
    failed = failed or result.returncode != 0 or counts.get("fail", 0) != 0 or counts.get("cancelled", 0) != 0
    if label != "mcp-check" and not counts.get("tests"):
        failed = True
    print(json.dumps(entry), flush=True)

after = identity()
summary["sourceAfter"] = after
summary["sourceStable"] = before == after
summary["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
failed = failed or before != after
summary["passed"] = not failed
(HERE / "regression-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
raise SystemExit(1 if failed else 0)
