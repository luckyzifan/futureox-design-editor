#!/usr/bin/env python3
"""Serial final CPU gates with frozen source/runtime identities; no GPU/build."""
from __future__ import annotations

import argparse
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
parser = argparse.ArgumentParser()
parser.add_argument("--label", default="v1")
options = parser.parse_args()
if not re.fullmatch(r"[a-z0-9-]{1,32}", options.label):
    parser.error("label must use lowercase letters, digits and hyphens")
OUT = HERE / f"final-cpu-{options.label}"


def required_input(name):
    value = os.environ.get(name)
    if not value or not Path(value).is_absolute():
        parser.error(f"{name} must name the actual absolute input path")
    return Path(value)


NODE = required_input("FINAL_CPU_NODE")
PYTHON = required_input("FINAL_CPU_PYTHON")
BACKEND = REPO / "design-studio/target/release/futureox-design-desktop-backend"
PREPARE = REPO / "design-studio/target/release/design-prepare"
SKETCH = required_input("FINAL_CPU_SKETCH")
FIG = required_input("FINAL_CPU_FIG")
DEFAULT_DESKTOP_DIST = REPO / "frontend/design-desktop/dist"
desktop_dist_input = os.environ.get("FINAL_CPU_DESKTOP_DIST")
if desktop_dist_input is not None:
    if not desktop_dist_input or not Path(desktop_dist_input).is_absolute():
        parser.error("FINAL_CPU_DESKTOP_DIST must name an actual absolute desktop dist directory")
    try:
        DESKTOP_DIST = Path(desktop_dist_input).resolve(strict=True)
    except OSError:
        parser.error("FINAL_CPU_DESKTOP_DIST is unavailable; no substitute or shared-dist fallback")
    if not DESKTOP_DIST.is_dir():
        parser.error("FINAL_CPU_DESKTOP_DIST must name a desktop dist directory")
else:
    DESKTOP_DIST = DEFAULT_DESKTOP_DIST


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def identity():
    folders = ["frontend/design-client/src", "frontend/design-client/scripts",
               "frontend/design-desktop/src", "frontend/design-desktop/scripts",
               "frontend/design-desktop/test", "frontend/design-mcp/src",
               "frontend/design-mcp/test", "frontend/design-mcp/examples"]
    names = set()
    for folder in folders:
        for path in (REPO / folder).rglob("*"):
            if path.is_file() and not set(path.relative_to(REPO / folder).parts).intersection(("node_modules", "dist", "__pycache__")):
                names.add(str(path.relative_to(REPO)))
    names.update(["frontend/design-client/package.json", "frontend/design-client/vitest.config.ts",
                  "frontend/design-desktop/package.json", "frontend/design-mcp/package.json"])
    values = {name: digest(REPO / name) for name in sorted(names)}
    return {"files": len(values), "sha256": hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest(), "entries": values}


def runtime_path_name(path):
    if path.is_relative_to(REPO):
        return str(path.relative_to(REPO))
    return "$FINAL_CPU_DESKTOP_DIST/" + str(path.relative_to(DESKTOP_DIST))


def desktop_dist_identity(dist):
    names = [dist / name for name in ("bin/design-prepare", "bin/design-render",
             "sidecar/futureox-design-desktop-backend", "renderer/kernel/design_kernel_bg.wasm",
             "build-manifest.json")]
    return {str(path.relative_to(dist)): {"exists": path.is_file(), "sha256": digest(path) if path.is_file() else None}
            for path in names}


def selected_dist_provenance():
    """An explicit dist is a checked cohort, never a native execution fallback."""
    manifest_path = DESKTOP_DIST / "build-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        manifest = {}
    if not isinstance(manifest, dict):
        manifest = {}
    checks = []
    counterparts = [("bin/design-prepare", PREPARE),
                    ("bin/design-render", REPO / "design-studio/target/release/design-render"),
                    ("sidecar/futureox-design-desktop-backend", BACKEND),
                    ("renderer/kernel/design_kernel_bg.wasm", REPO / "frontend/design-client/public/kernel/design_kernel_bg.wasm"),
                    ("renderer/kernel/design_kernel_bg.wasm", REPO / "frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm")]
    for name, counterpart in counterparts:
        path = DESKTOP_DIST / name
        actual = digest(path) if path.is_file() else None
        expected = digest(counterpart) if counterpart.is_file() else None
        checks.append({"artifact": name, "sha256": actual,
                       "matchesPath": str(counterpart.relative_to(REPO)),
                       "matchesSha256": expected, "matches": actual is not None and actual == expected})
    sources = manifest.get("sources")
    source_mismatches = []
    if isinstance(sources, dict):
        for name, expected in sources.items():
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts or not isinstance(expected, str):
                source_mismatches.append(name)
                continue
            path = REPO / relative
            if not path.is_file() or digest(path) != expected:
                source_mismatches.append(name)
    valid = (manifest.get("format") == 1 and manifest.get("profile") == "release"
             and isinstance(sources, dict) and bool(sources) and not source_mismatches
             and all(check["matches"] for check in checks))
    return {"directory": str(DESKTOP_DIST.relative_to(REPO)) if DESKTOP_DIST.is_relative_to(REPO) else "$FINAL_CPU_DESKTOP_DIST",
            "selection": "explicit FINAL_CPU_DESKTOP_DIST; no shared-dist fallback",
            "manifestSha256": digest(manifest_path) if manifest_path.is_file() else None,
            "profile": manifest.get("profile"), "builtAt": manifest.get("builtAt"),
            "manifestSourceFiles": len(sources) if isinstance(sources, dict) else None,
            "manifestSourceMismatches": source_mismatches, "artifactChecks": checks, "valid": valid}


def runtime_identity():
    names = [BACKEND, PREPARE, REPO / "design-studio/target/release/design-render",
             REPO / "frontend/design-client/public/kernel/design_kernel_bg.wasm",
             REPO / "frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm",
             DESKTOP_DIST / "bin/design-prepare",
             DESKTOP_DIST / "bin/design-render",
             DESKTOP_DIST / "sidecar/futureox-design-desktop-backend",
             DESKTOP_DIST / "renderer/kernel/design_kernel_bg.wasm",
             REPO / "frontend/design-client/public/fonts/NotoSansSC.ttf"]
    if desktop_dist_input is not None:
        names.append(DESKTOP_DIST / "build-manifest.json")
    return {runtime_path_name(path): {"exists": path.is_file(), "sha256": digest(path) if path.is_file() else None}
            for path in names}


def rust_identity():
    roots = ["design-studio", "vendor/moxcms", "rust-toolchain.toml", ".cargo/config.toml",
             "testing/fixtures", "frontend/design-client/public/fonts", "frontend/design-client/public/fidelity"]
    paths = subprocess.check_output(["git", "ls-files", "-z", "--", *roots], cwd=REPO).decode().split("\0")
    values = {name: digest(REPO / name) for name in sorted(set(paths)) if name and (REPO / name).is_file()}
    return {"files": len(values), "sha256": hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()}


def tap_counts(text):
    return {key: int(matches[-1]) for key in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo")
            if (matches := re.findall(rf"^(?:#|ℹ) {key} (\d+)\s*$", text, re.MULTILINE))}


def redact(text):
    text = text.replace("ephemeral-test-token-1234567890", "[fixture-token]")
    text = re.sub(r"(?:/[^\s'\"\]\[,)]+)+\.sock", "[fixture-socket]", text)
    return re.sub(r"([\"']?(?:token|bridgeToken|FUTUREOX_DESIGN_BRIDGE_TOKEN)[\"']?\s*[:=]\s*)[\"']?[^\s,}\"']+[\"']?", r"\1[redacted]", text, flags=re.IGNORECASE)


env = {key: value for key, value in os.environ.items()
       if not key.startswith(("FUTUREOX_DESIGN_", "VITE_DESIGN_")) and key not in ("CORE_GPU_WORKING_BUDGET_MIB", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE")}
env.update({"PATH": str(NODE.parent) + os.pathsep + str(PYTHON.parent) + os.pathsep + env.get("PATH", ""),
            "PYTHON": str(PYTHON), "TMPDIR": os.path.realpath(tempfile.gettempdir()),
            "SKETCH_FIXTURE": str(SKETCH), "DESIGN_TEST_SKETCH": str(SKETCH),
            "FIG_FIXTURE": str(FIG), "DESIGN_TEST_FIG": str(FIG), "FUTUREOX_REAL_FIG_TEST_FILE": str(FIG),
            "DESIGN_REQUIRE_PRIVATE_FIXTURES": "1", "CANVAS_REPRO_ADD_PAGE": "1",
            "FUTUREOX_BACKEND_TEST_BINARY": str(BACKEND), "CORE_DESKTOP_SIDECAR": str(BACKEND),
            "DESIGN_PREPARE_BINARY": str(PREPARE),
            "CORE_DESKTOP_TEST_SOURCE": (REPO / "frontend/design-desktop/src").as_uri() + "/"})
for path in (NODE, PYTHON, BACKEND, PREPARE, SKETCH, FIG):
    if not path.is_file():
        raise SystemExit(f"Required actual input unavailable: {path.name}; no substitute or skip")
versions = subprocess.check_output([str(PYTHON), "-c", "import json,sys,PIL,fontTools; print(json.dumps({'python':sys.version.split()[0],'Pillow':PIL.__version__,'fonttools':fontTools.__version__}))"], env=env, text=True)
versions = json.loads(versions)
assert versions["Pillow"] == "12.0.0" and versions["fonttools"] == "4.61.1", versions
node_version = subprocess.check_output([str(NODE), "--version"], env=env, text=True).strip()
assert node_version == "v24.12.0", node_version
selected_dist_before = selected_dist_provenance() if desktop_dist_input is not None else None
if selected_dist_before is not None and not selected_dist_before["valid"]:
    raise SystemExit("Explicit desktop dist is not the current guarded release cohort: " + json.dumps(selected_dist_before))
OUT.mkdir(exist_ok=False)
before = identity()
runtime_before = runtime_identity()
shared_default_before = desktop_dist_identity(DEFAULT_DESKTOP_DIST) if desktop_dist_input is not None else None
rust_before = rust_identity()
prior_rust = json.loads((HERE / "rust-regression-summary.json").read_text())["sourceBefore"]["sha256"]
assert rust_before["sha256"] == prior_rust, "Rust inputs changed; prior workspace result cannot be reused"
summary = {"startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "output": OUT.name, "node": node_version, **versions,
           "sourceScope": "Actual client src/scripts, desktop src/scripts/tests, MCP src/tests/examples and package/config files; independent of ignored test outputs",
           "sourceBefore": before, "runtimeBefore": runtime_before,
           "rustInputCheckBefore": {**rust_before, "matchesPriorWorkspaceRun": True, "testsRerun": False},
           "fixtureInputs": {"117.sketch": digest(SKETCH), "FIG": digest(FIG)},
           "optionalNativeCorpusEnabled": True, "canvasReproducerEnabled": True,
           "temporaryPathPolicy": "Canonical OS temporary directory",
           "buildProvenance": "Existing WASM and release native binaries; no build, Rust test, GUI or GPU run",
           "gates": []}
summary["vitestMaxWorkers"] = 1
summary["commandNotation"] = "Repository-relative arguments; external executable placeholders are supplied by FINAL_CPU_NODE/FINAL_CPU_PYTHON. Actual versions and fixture hashes are recorded."
if selected_dist_before is not None:
    summary["selectedDesktopDistBefore"] = selected_dist_before
    summary["runtimeIdentityScope"] = "Explicit selected desktop dist, its manifest, release native executables, public/generated WASM and font; all remain strict before/after guards"
    summary["nativeExecutionInputs"] = {"FUTUREOX_BACKEND_TEST_BINARY": str(BACKEND.relative_to(REPO)),
                                        "CORE_DESKTOP_SIDECAR": str(BACKEND.relative_to(REPO)),
                                        "DESIGN_PREPARE_BINARY": str(PREPARE.relative_to(REPO))}
    summary["sharedDefaultDistObservation"] = {"scope": "Separate observation; never a native execution input. The explicitly selected artifact remains strictly guarded even if the same directory is selected. Changes to any selected artifact/source/WASM/release binary still invalidate the run.",
                                               "isSelectedArtifact": DEFAULT_DESKTOP_DIST.resolve() == DESKTOP_DIST,
                                               "before": shared_default_before}
vitest_json = OUT / "client-vitest.json"
phases = [
    ("client-vitest", [str(NODE), str(REPO / "frontend/design-client/node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1", "--reporter=default", "--reporter=json", f"--outputFile.json={vitest_json}"], "frontend/design-client", "vitest"),
    ("desktop-node", [str(NODE.parent / "npm"), "test"], "frontend/design-desktop", "tap"),
    ("desktop-preparation", [str(NODE.parent / "npm"), "run", "test:preparation"], "frontend/design-desktop", "tap"),
    ("frontend-node", [str(NODE), "testing/verify-local.mjs", "--suites", "frontend-contracts", "--output", str(OUT / "frontend-node")], "", "frontend-harness"),
    ("mcp-check", [str(NODE.parent / "npm"), "run", "check"], "frontend/design-mcp", "syntax"),
    ("mcp-unit", [str(NODE.parent / "npm"), "test"], "frontend/design-mcp", "tap"),
    ("mcp-clipboard", [str(NODE), "--test", "test/clipboard-artifacts.test.mjs"], "frontend/design-mcp", "tap"),
    ("mcp-socket", [str(NODE.parent / "npm"), "run", "test:integration"], "frontend/design-mcp", "tap"),
]
failed = False
for name, command, cwd, kind in phases:
    started = time.monotonic()
    print(json.dumps({"running": name}), flush=True)
    result = subprocess.run(command, cwd=REPO / cwd, env=env, capture_output=True, text=True)
    text = redact(result.stdout + result.stderr)
    (OUT / f"{name}.log").write_text(text)
    entry = {"name": name, "cwd": cwd, "exitCode": result.returncode,
             "wallSeconds": round(time.monotonic() - started, 3), "log": f"{OUT.name}/{name}.log"}
    entry["command"] = [arg.replace(str(REPO) + "/", "").replace(str(NODE.parent / "npm"), "$FINAL_CPU_NODE_DIR/npm").replace(str(NODE), "$FINAL_CPU_NODE") for arg in command]
    good = result.returncode == 0
    if kind == "vitest" and vitest_json.is_file():
        data = json.loads(vitest_json.read_text())
        entry["counts"] = {"total": data["numTotalTests"], "passed": data["numPassedTests"], "failed": data["numFailedTests"], "skipped": data["numPendingTests"], "todo": data.get("numTodoTests", 0), "suitesPassed": data["numPassedTestSuites"], "suitesFailed": data["numFailedTestSuites"]}
        good = good and data["success"] and data["numPassedTests"] > 0 and not (data["numFailedTests"] or data["numPendingTests"] or data.get("numTodoTests", 0))
        entry["report"] = f"{OUT.name}/client-vitest.json"
    elif kind == "frontend-harness":
        report = json.loads((OUT / "frontend-node/results.json").read_text())
        suite = next(row for row in report["suites"] if row["id"] == "frontend-contracts")
        entry["counts"] = tap_counts((OUT / "frontend-node/frontend-contracts.log").read_text())
        entry["report"] = f"{OUT.name}/frontend-node/results.json"
        good = good and suite["status"] == "passed" and entry["counts"].get("pass", 0) > 0 and not any(entry["counts"].get(key, 0) for key in ("fail", "cancelled", "skipped", "todo"))
    elif kind == "tap":
        entry["counts"] = tap_counts(text)
        good = good and entry["counts"].get("pass", 0) > 0 and not any(entry["counts"].get(key, 0) for key in ("fail", "cancelled", "skipped", "todo"))
    entry["status"] = "passed" if good else "failed"
    summary["gates"].append(entry)
    print(json.dumps(entry), flush=True)
    (OUT / "progress-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    if not good:
        failed = True
        break
after = identity()
runtime_after = runtime_identity()
selected_dist_after = selected_dist_provenance() if desktop_dist_input is not None else None
rust_after = rust_identity()
summary.update({"sourceAfter": {key: after[key] for key in ("files", "sha256")},
                "sourceStable": before == after, "runtimeAfter": runtime_after, "runtimeStable": runtime_before == runtime_after,
                "rustInputCheckAfter": {**rust_after, "matchesPriorWorkspaceRun": rust_after["sha256"] == prior_rust},
                "fixtureInputsAfter": {"117.sketch": digest(SKETCH), "FIG": digest(FIG)},
                "finishedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
summary["changedSourcePaths"] = [name for name in sorted(set(before["entries"]) | set(after["entries"])) if before["entries"].get(name) != after["entries"].get(name)]
summary["passed"] = not failed and before == after and runtime_before == runtime_after and rust_after["sha256"] == prior_rust and summary["fixtureInputs"] == summary["fixtureInputsAfter"]
if selected_dist_after is not None:
    summary["selectedDesktopDistAfter"] = selected_dist_after
    summary["selectedDesktopDistStable"] = selected_dist_before == selected_dist_after
    shared_default_after = desktop_dist_identity(DEFAULT_DESKTOP_DIST)
    summary["sharedDefaultDistObservation"].update({"after": shared_default_after, "stable": shared_default_before == shared_default_after,
                                                  "changedPaths": [name for name in sorted(shared_default_before) if shared_default_before[name] != shared_default_after[name]]})
    summary["passed"] = summary["passed"] and selected_dist_after["valid"] and summary["selectedDesktopDistStable"]
(OUT / "run-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
(HERE / "final-cpu-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({key: summary[key] for key in ("passed", "sourceStable", "runtimeStable", "changedSourcePaths")}), flush=True)
raise SystemExit(0 if summary["passed"] else 1)
