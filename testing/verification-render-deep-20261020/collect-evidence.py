"""Curate numerical evidence only; never copy fixture documents or browser profiles."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def read(relative):
    return json.loads((ROOT / relative).read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def events(directory):
    result = []
    for line in (ROOT / directory / "host-stdout.log").read_text().splitlines():
        if "[render-diag] " not in line:
            continue
        try:
            result.extend(json.loads(line.split("[render-diag] ", 1)[1]).get("batch", []))
        except (ValueError, TypeError):
            pass
    return result

runs = {}
for directory in ["baseline-clean-hover-117", "accepted-normal-117", "accepted-held-117",
                  "baseline-name-fig", "accepted-fig"]:
    report = read(f"{directory}/results.json")
    log = events(directory)
    stages = []
    for stage in report["stages"]:
        rows = [row for row in log if stage["wallStart"] <= row["at"] <= stage["wallEnd"]]
        tiles = [row for row in rows if row["event"] == "tile"]
        fences = [row for row in rows if row["event"] == "fence"]
        stages.append({
            "name": stage["name"], "actionMs": stage["actionMs"], "totalMs": stage["totalMs"],
            "afterActionToReadyMs": stage["totalMs"] - stage["actionMs"],
            "ready": stage["settled"]["ok"], "raf": stage["raf"], "tiles": len(tiles),
            "fieldBuildMs": sum(row.get("fieldBuildElapsedMs", 0) for row in tiles),
            "passPixelVisits": sum(row.get("encodedPassPixels", 0) for row in tiles),
            "horizontalHits": sum(row.get("horizontalFilterHits", 0) for row in tiles),
            "horizontalRows": sum(row.get("horizontalFilterRows", 0) for row in tiles),
            "completionWaits": len(fences),
            "completionWaitMs": sum(row.get("queueWaitMs", 0) for row in fences),
            "interaction": {key: value for key, value in stage["settled"].get("compositor", {}).items()
                            if key.startswith("interaction") or key == "contentSequence"},
        })
    edit = report.get("extended", {}).get("edit", {})
    comparison = ROOT / directory / "screenshot-comparison.json"
    runs[directory] = {
        "status": report.get("status"), "startedAt": report["startedAt"],
        "fixture": "FIG" if report["fixture"].endswith(".fig") else "117.sketch",
        "fixtureSha256": report["fixtureSha256"], "sampling": report["sampling"],
        "profileStages": report.get("profileStages", []), "diagnostics": report["diagnostics"],
        "errors": report["errors"], "stages": stages, "editChanged": edit.get("changed"),
        "undoRestoredCompleteDocument": edit.get("undoRestoredCompleteDocument"),
        "screenshotComparison": json.loads(comparison.read_text()) if comparison.exists() else None,
        "buildManifestSha256": digest(ROOT / directory / "build-manifest.json"),
        "artifacts": {Path(name).name: value for name, value in
                      read(f"{directory}/runtime-artifacts.json")["artifacts"].items()},
    }
    if "heldPreview" in edit:
        runs[directory]["heldPreviewWaitMs"] = edit["heldPreview"]["waitMs"]
        runs[directory]["heldBufferComparison"] = read(f"{directory}/held-buffer-comparison.json")

summary = {
    "acceptance": "Incomplete: first 3200% and live drag latency remain too high; no Figma or physical 90/120 FPS acceptance.",
    "environment": "Visible release Electron, Apple Metal 3, 1440x960 CSS viewport, DPR 2; isolated local workspace.",
    "runs": runs,
    "limits": [
        "One fresh baseline per fixture; two accepted 117 runs, with CPU sampling on selected phases in the held run.",
        "Held drag intentionally waits for the last input to be acknowledged before pointer-up; its total is not comparable to the normal drag.",
        "UI rAF intervals and GPU submission acknowledgements are not physical displayed FPS.",
        "Queue completion waits include scheduling and other GPU clients; overlapping hardware timestamp intervals cannot be summed as exclusive shader time.",
        "Figma and StorageManagement were not terminated. Background load and shader compilation order can affect results.",
    ],
}
(ROOT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
gpu = {}
for name in ["accepted-gpu-image-fusion", "accepted-gpu-filter-copy", "prefix-crossover"]:
    report = read(f"{name}/results.json")
    result = report["result"]
    gpu[name] = {"status": report["status"], "errors": report.get("errors", []),
                 "result": {key: value for key, value in result.items()
                            if key not in ["rows", "records", "summaries"]}}
cpu = read("accepted-held-117/cpu-summary.json")
gpu["sampledCpu"] = [{key: row[key] for key in
                     ["file", "samples", "activeMs", "idleMs", "programMs", "gcMs", "topSelf"]}
                    for row in cpu if row["file"].startswith("zoom-3200")]
(ROOT / "gpu-summary.json").write_text(json.dumps(gpu, ensure_ascii=False, indent=2) + "\n")
(ROOT / "accepted-build-manifest.json").write_text(
    (ROOT / "accepted-normal-117/build-manifest.json").read_text())
