"""Read existing results only; never launch the application."""
import collections
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
report = {
    "scope": "Local Electron measurements; rAF is not physical frame rate. "
             "Warm-up, order, profiling and background application activity matter.",
    "runs": [],
}
for path in sorted(ROOT.glob("*/results.json")):
    data = json.loads(path.read_text())
    if "stages" not in data:
        continue
    row = {
        "run": path.parent.name,
        "rawResultSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        **{key: data.get(key) for key in (
            "startedAt", "fixtureSha256", "sampling", "status", "adapter",
            "navigationPreservedDocument", "presentationPassed",
        )},
        "stages": [{
            "name": stage["name"], "totalMs": stage["totalMs"],
            "actionMs": stage["actionMs"], "raf": stage["raf"],
            "settled": stage["settled"]["ok"],
            "maxLongTaskMs": max((t["duration"] for t in stage["longtasks"]), default=0),
        } for stage in data["stages"]],
    }
    manifest = path.parent / "build-manifest.json"
    if manifest.exists():
        row["buildManifestSha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        row["builtAt"] = json.loads(manifest.read_text())["builtAt"]
    if data.get("extended"):
        extended = data["extended"]
        row["editing"] = {
            "status": extended.get("status"),
            "wheelPreservedDocument": extended.get("wheel", {}).get("documentPreserved"),
            **{key: extended.get("edit", {}).get(key) for key in (
                "mode", "changed", "nodeCountPreserved", "undoRestoredCompleteDocument",
            )},
            "sourceFilePreserved": extended.get("sourceFilePreserved"),
        }
    log = path.parent / "host-stdout.log"
    if data.get("sampling") and log.exists():
        stage = next(s for s in data["stages"] if s["name"] == "zoom-3200")
        events = []
        parse_errors = 0
        for line in log.read_text().splitlines():
            if "[render-diag] " not in line:
                continue
            try:
                batch = json.loads(line.split("[render-diag] ", 1)[1])
            except ValueError:
                parse_errors += 1
                continue
            events.extend(batch.get("batch", [batch]))
        events = [e for e in events if stage["wallStart"] <= e.get("at", 0) <= stage["wallEnd"]]
        counts = collections.Counter(e.get("requestId") for e in events if e.get("event") == "tile")
        diagnostics = []
        for request_id, count in counts.items():
            own = [e for e in events if e.get("requestId") == request_id]
            tiles = [e for e in own if e.get("event") == "tile"]
            fences = [e for e in own if e.get("event") == "fence"]
            diagnostics.append({
                "requestId": request_id, "tiles": count,
                **{key: sum(e.get(key, 0) for e in tiles) for key in (
                    "materialFieldBuilds", "materialFieldUploadBytes", "fieldBuildElapsedMs",
                    "tileDrawCalls", "encodedPassPixels", "graphNonCheckpointElapsedMs",
                )},
                "completionWaitMs": sum(e.get("queueWaitMs", 0) for e in fences),
                "completionWaitCount": len(fences),
            })
        row["zoomDiagnostics"] = {"logParseErrors": parse_errors, "requests": diagnostics}
    report["runs"].append(row)
report["runs"].sort(key=lambda row: row["startedAt"] or "")
(ROOT / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
