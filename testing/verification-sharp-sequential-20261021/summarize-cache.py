#!/usr/bin/env python3
"""Allowlisted revisit and actual fence evidence; never launches an app/test."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("motion_evidence", HERE / "summarize-motion.py")
motion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(motion)


def summarize(directory):
    report_bytes = (directory / "results.json").read_bytes()
    report = json.loads(report_bytes)
    rows, _ = motion.events(directory / "host-stdout.log")
    stages = []
    for stage in report["stages"]:
        if stage["name"] not in ("zoom-100", "pan-100", "zoom-3200", "pan-3200"):
            continue
        fences = [row for row in rows if row["source"] == "worker" and row["event"] == "fence"
                  and stage["wallStart"] <= row["at"] <= stage["wallEnd"]]
        pool = [row for row in fences if motion.pool_only(row)]
        stages.append({"name": stage["name"], "ok": stage["settled"].get("ok"),
            "allFences": len(fences), "allQueueWaitMs": round(sum(row.get("queueWaitMs", 0) for row in fences), 3),
            "poolOnlyFences": len(pool), "poolOnlyQueueWaitMs": round(sum(row.get("queueWaitMs", 0) for row in pool), 3)})
    visits = [{key: visit.get(key) for key in ("round", "percent", "ok", "sameCameraAsPreviousVisit",
        "renderedTiles", "cacheHits", "residentBytes", "residentBudget", "coverage", "sharpCoverage", "missingTextureCount")}
        for visit in report.get("cacheRevisit", {}).get("visits", [])]
    return {"label": directory.name, "reportSha256": hashlib.sha256(report_bytes).hexdigest(),
        "buildManifestSha256": hashlib.sha256((directory / "build-manifest.json").read_bytes()).hexdigest(),
        "fixtureSha256": report["fixtureSha256"], "status": report["status"],
        "navigationPreservedDocument": report.get("navigationPreservedDocument"),
        "sampling": report["sampling"], "stages": stages, "visits": visits}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", nargs="+", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    value = {"scope": "Exact-camera five-second-idle revisit and time-windowed queue-completion observations. Existing native cache hits are not a new-fix benefit. Single paired observations do not establish a general speedup or eliminate motion blur. No photon/FPS claim.",
        "runs": [summarize(path) for path in args.runs]}
    output = json.dumps(value, indent=2, allow_nan=False) + "\n"
    if args.out:
        args.out.write_text(output)
    else:
        print(output, end="")
