#!/usr/bin/env python3
"""Summarize existing runs only; never launches the app or renders a reference."""
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent
REASONS = ["unknown", "readback", "timing", "prefix-scratch", "interaction",
           "periodic", "admission", "checkpoint", "cancel", "initialization",
           "park", "image-table-scratch"]
PREFIXES = ["default-current", "cache-checkpoint", "resident-filter-v1", "resident-filter-v2", "final-default", "final-safe-default"]


def expand(value):
    if isinstance(value, dict) and isinstance(value.get("batch"), list):
        for item in value["batch"]:
            yield from expand(item)
    elif isinstance(value, dict):
        yield value


def diagnostics(directory):
    records = {}
    for line in (directory / "host-stdout.log").read_text().splitlines():
        try:
            value = json.loads(line[line.index("{"):])
        except (ValueError, json.JSONDecodeError):
            continue
        for row in expand(value):
            if "session" in row and "seq" in row:
                records[(row["session"], row.get("source"), row["seq"])] = row
    return list(records.values())


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def camera(stage):
    data = stage.get("settled", {}).get("presentation", {})
    return {key: number(data.get(key)) for key in
            ["cameraX", "cameraY", "cameraZoom", "pixelRatio"]}


def viewport(result):
    value = result.get("viewportEnvironment", {})
    return {key: number(value.get(key)) for key in ["width", "height", "dpr"]}


def rounded_sum(rows, field):
    return round(sum(row.get(field, 0) for row in rows), 3)


def summarize_stage(stage, records):
    rows = [row for row in records if stage["wallStart"] <= row.get("at", 0) <= stage["wallEnd"]]
    fences = [row for row in rows if row.get("event") == "fence"]
    tiles = [row for row in rows if row.get("source") == "main" and row.get("event") == "tile"]
    counters = [row for row in rows if row.get("event") == "prefix" and "acceptedLines" in row]
    maps = [row for row in rows if row.get("event") == "prefix" and "mapMs" in row]
    reason_counts = Counter(row.get("reasonCode", 0) for row in fences)
    return {
        "actionMs": round(stage.get("actionMs", 0), 3),
        "totalMs": round(stage.get("totalMs", 0), 3),
        "actionReturnToSettledMs": round(stage["totalMs"] - stage["actionMs"], 3)
            if isinstance(stage.get("totalMs"), (int, float)) and isinstance(stage.get("actionMs"), (int, float)) else None,
        "settled": stage.get("settled", {}).get("ok"),
        "camera": camera(stage),
        "fences": len(fences), "queueWaitMs": rounded_sum(fences, "queueWaitMs"),
        "reasons": {REASONS[code]: {"count": reason_counts[code], "queueWaitMs":
                    rounded_sum([row for row in fences if row.get("reasonCode") == code], "queueWaitMs")}
                    for code in sorted(reason_counts) if 0 <= code < len(REASONS)},
        "admissionRetiredKinds": {str(kind): {"count": len(group := [row for row in fences
            if row.get("reasonCode") == 6 and row.get("admissionRetiredKinds") == kind]),
            "queueWaitMs": rounded_sum(group, "queueWaitMs")}
            for kind in sorted({row.get("admissionRetiredKinds", 0) for row in fences if row.get("reasonCode") == 6})},
        "terminalTiles": len(tiles),
        "tileSums": {field: rounded_sum(tiles, field) for field in
            ["compileMs", "graphMs", "finishMs", "checkpointMs", "materialFieldBuilds",
             "materialFieldHits", "materialFieldUploadBytes", "fieldBuildElapsedMs",
             "imageXTableBuilds", "imageXTablePixels", "horizontalFilterHits", "horizontalFilterPixels"]},
        "prefixCounterSamples": len(counters), "prefixMapSamples": len(maps),
        "prefixMapMs": rounded_sum(maps, "mapMs"),
        "deferredCounterMetricAvailable": any("deferred" in key.lower() for row in rows for key in row),
    }


def file_sha(path):
    return sha256(path.read_bytes()).hexdigest()


def compare_canvas(baseline_dir, candidate_dir, baseline, candidate):
    baseline_stages = {stage["name"]: stage for stage in baseline["stages"]}
    comparisons = {}
    for stage in candidate["stages"]:
        name = stage["name"]
        first, second = baseline_dir / f"{name}-canvas.png", candidate_dir / f"{name}-canvas.png"
        if name not in baseline_stages or not first.exists() or not second.exists():
            continue
        base_camera, next_camera = camera(baseline_stages[name]), camera(stage)
        row = {
            "cameraEqual": base_camera == next_camera and all(value is not None for value in base_camera.values()),
            "viewportEqual": viewport(baseline) == viewport(candidate),
            "captureModeEqual": baseline.get("captureMode") == candidate.get("captureMode"),
            "fixtureBytesEqual": baseline.get("fixtureSha256") == candidate.get("fixtureSha256"),
            "pngBytesEqual": file_sha(first) == file_sha(second),
        }
        with Image.open(first) as a, Image.open(second) as b:
            row["baselineDimensions"], row["candidateDimensions"] = list(a.size), list(b.size)
            row["dimensionsEqual"] = a.size == b.size
            row["metadataComparable"] = all(row[key] for key in
                ["cameraEqual", "viewportEqual", "captureModeEqual", "fixtureBytesEqual", "dimensionsEqual"])
            if row["metadataComparable"]:
                delta = ImageChops.difference(a.convert("RGBA"), b.convert("RGBA"))
                bands = delta.split()
                mask = bands[0]
                for band in bands[1:]:
                    mask = ImageChops.lighter(mask, band)
                histogram = mask.histogram()
                row["differentPixels"] = a.width * a.height - histogram[0]
                row["maximumChannelDifference"] = max(index for index, count in enumerate(histogram) if count)
                row["differenceBounds"] = list(mask.getbbox()) if mask.getbbox() else None
            else:
                row["differentPixels"] = None
        comparisons[name] = row
    return comparisons


def export_summary(directory, result, baseline_dir, baseline):
    exports = result.get("exportVerification", {})
    assets = []
    for asset in exports.get("assets", []):
        other = next((item for item in baseline.get("exportVerification", {}).get("assets", [])
                      if item.get("scale") == asset.get("scale")), {})
        path, base_path = directory / asset["file"], baseline_dir / other.get("file", "missing")
        actual, original = file_sha(path) if path.is_file() else None, file_sha(base_path) if base_path.is_file() else None
        assets.append({"scale": asset.get("scale"), "sha256": actual,
                       "recordMatchesFile": actual == asset.get("sha256"),
                       "baselineRecordMatchesFile": original == other.get("sha256"),
                       "bytesEqualBaseline": actual == original and actual is not None,
                       "width": asset.get("width"), "height": asset.get("height")})
    return {"status": exports.get("status"), "documentPreserved": exports.get("documentPreserved"),
            "sourceFilePreserved": exports.get("sourceFilePreserved"), "assets": assets}


def main():
    summary = {"scope": "Existing completed runs only; stage wall windows; recursive batch dedup session/source/seq.",
        "limitations": ["Queue completion waits are not GPU-exclusive compute time.",
            "Sampled settled canvas PNGs do not establish every intermediate frame is clear or complete.",
            "Cross-run imported document IDs differ; comparisons bind source fixture bytes, camera, DPR, viewport and capture dimensions.",
            "Prefix/table waits may move to admission or periodic boundaries; compare total wait and actual stage duration."],
        "runs": {}, "pendingRuns": []}
    for fixture in ["117", "fig"]:
        baseline_dir = ROOT / f"default-current-{fixture}"
        baseline = json.loads((baseline_dir / "results.json").read_text())
        for prefix in PREFIXES:
            directory = ROOT / f"{prefix}-{fixture}"
            path = directory / "results.json"
            if not path.exists():
                summary["pendingRuns"].append(directory.name)
                continue
            result = json.loads(path.read_text())
            if result.get("status") != "completed":
                summary["pendingRuns"].append(directory.name)
                continue
            records = diagnostics(directory)
            edit = result.get("extended", {}).get("edit", {})
            summary["runs"][directory.name] = {
                "status": result["status"], "fixtureSha256": result.get("fixtureSha256"),
                "viewport": viewport(result), "errors": len(result.get("errors", [])),
                "navigationPreservedDocument": result.get("navigationPreservedDocument"),
                "fullDocumentUndoRestored": edit.get("undoRestoredCompleteDocument"),
                "undoHashEqualsBeforeEdit": edit.get("undoSha256") == edit.get("beforeSha256") if edit else None,
                "export": export_summary(directory, result, baseline_dir, baseline),
                "stages": {stage["name"]: summarize_stage(stage, records) for stage in result["stages"]},
                "settledCanvasComparisonToBaseline": compare_canvas(baseline_dir, directory, baseline, result),
            }
    output = ROOT / "resident-filter-summary.json"
    output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"runs": list(summary["runs"]), "pendingRuns": summary["pendingRuns"], "output": output.name}))


if __name__ == "__main__":
    main()
