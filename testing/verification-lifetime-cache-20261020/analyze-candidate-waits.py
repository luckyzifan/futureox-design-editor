#!/usr/bin/env python3
"""Read existing Electron records; never launch or modify the application."""
import collections
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "testing/verification-real-electron-flames-20261020/117-run1"
CANDIDATE = ROOT / "testing/verification-lifetime-cache-20261020/candidate1-117"
REASONS = ["readback", "timing", "prefix-scratch", "interaction", "periodic",
           "admission", "checkpoint", "cancel", "initialization", "park"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def records(path):
    events, errors, dropped = [], [], []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if "[render-diag] " not in line:
            continue
        try:
            value = json.loads(line.split("[render-diag] ", 1)[1])
        except ValueError as error:
            errors.append({"line": number, "error": str(error)})
            continue
        for record in value.get("batch", [value]):
            events.append({**record, "logLine": number})
            if any("drop" in key.lower() and isinstance(count, (int, float)) and count > 0
                   for key, count in record.items()):
                dropped.append(events[-1])
    return events, {"events": len(events), "parseErrors": errors, "nonzeroDropFields": dropped}


def waits(events):
    by_reason = collections.defaultdict(list)
    for event in events:
        if event["event"] == "fence":
            by_reason[REASONS[event["reasonCode"] - 1]].append(event)
    return {name: {"count": len(rows), "cpuWaitMs": sum(row["queueWaitMs"] for row in rows),
                   "maxCpuWaitMs": max(row["queueWaitMs"] for row in rows)}
            for name, rows in by_reason.items()}


def cpu(path):
    value = json.loads(path.read_text())
    nodes = {node["id"]: node for node in value["nodes"]}
    times = collections.Counter()
    for sample, delta in zip(value.get("samples", []), value.get("timeDeltas", [])):
        name = nodes[sample]["callFrame"]["functionName"]
        times[name if name in ["(idle)", "(program)", "(garbage collector)"] else "active"] += delta
    return {name: value / 1000 for name, value in times.items()}


def analyze(path, request_id):
    events, integrity = records(path / "host-stdout.log")
    result = json.loads((path / "results.json").read_text())
    chosen = [row for row in events if row.get("requestId") == request_id]
    tiles = [row for row in chosen if row["event"] == "tile"]
    fences = [row for row in chosen if row["event"] == "fence"]
    prefix = [row for row in chosen if row["event"] == "prefix"]
    large = [row for row in fences if row["queueWaitMs"] > 100]
    sums = ["graphMs", "checkpointMs", "finishMs", "fieldBuildElapsedMs", "materialFieldBuilds",
            "materialFieldHits", "materialFieldUploadBytes", "tileDrawCalls",
            "tileCommandSubmissions", "encodedPassPixels", "graphNonCheckpointElapsedMs"]
    out = {
        "directory": str(path.relative_to(ROOT)), "requestId": request_id,
        "sources": {name: digest(path / name) for name in ["host-stdout.log", "results.json", "build-manifest.json"]},
        "fixtureSha256": result["fixtureSha256"], "integrity": integrity,
        "zoomStage": next(stage for stage in result["stages"] if stage["name"] == "zoom-3200"),
        "panStage": next(stage for stage in result["stages"] if stage["name"] == "pan-3200"),
        "queue": [row for row in chosen if row["event"] in ["queue-start", "queue-end"]],
        "result": next(row for row in chosen if row["event"] == "result"),
        "tileCount": len(tiles), "totals": {key: sum(row.get(key, 0) for row in tiles) for key in sums},
        "buildCountDistribution": dict(collections.Counter(row["materialFieldBuilds"] for row in tiles)),
        "waits": waits(chosen),
        "prefixCounters": {key: sum(row.get(key, 0) for row in prefix)
                           for key in ["acceptedLines", "declinedLines", "acceptedPixels", "mapMs"]},
        "prefixAllocations": [row for row in prefix if "scratchBytes" in row],
        "prefixCounterRows": [row for row in prefix if "acceptedLines" in row],
        "longFences": large,
        "longFenceTotals": {"count": len(large), "cpuWaitMs": sum(row["queueWaitMs"] for row in large)},
        "tileRecords": tiles, "fenceRecords": fences,
        "cpuSampleMs": {name: cpu(path / (name + ".cpuprofile")) for name in
                        ["zoom-3200-0", "zoom-3200-1", "pan-3200-0", "pan-3200-1"]},
    }
    if "wallStart" in out["panStage"]:
        stage = out["panStage"]
        pan = [row for row in events if stage["wallStart"] <= row["at"] <= stage["wallEnd"]]
        out["panRequests"] = [
            {"requestId": rid, "queue": [row for row in pan if row.get("requestId") == rid and
                                        row["event"] in ["queue-start", "queue-end"]],
             "waits": waits([row for row in pan if row.get("requestId") == rid]),
             "longFences": [row for row in pan if row.get("requestId") == rid and
                            row["event"] == "fence" and row["queueWaitMs"] > 100],
             "workerErrors": [row for row in pan if row.get("requestId") == rid and
                              row["event"] == "error" and row.get("source") == "worker"]}
            for rid in sorted({row["requestId"] for row in pan if row["event"] == "queue-start"})]
        out["panWaits"] = waits(pan)
        out["presenterObservedCounters"] = {
            key: {"observations": len(values), "minimum": min(values, default=None), "maximum": max(values, default=None)}
            for key in ["deviceRetiringPayloadBytes", "deviceLogicalPayloadBytes",
                        "devicePendingCaptures", "devicePendingCapturePayloadBytes"]
            if (values := [row[key] for row in events if key in row])
        }
    return out


baseline, candidate = analyze(BASE, 103), analyze(CANDIDATE, 98)
fields = ["x", "y", "zoom", "width", "height", "phaseX", "phaseY"]
report = {
    "schema": 1,
    "purpose": "Read-only comparison of recorded candidate1 and baseline first 3200% 117 Electron workloads.",
    "baseline": baseline, "candidate": candidate,
    "comparison": {
        "fixtureHashMatches": baseline["fixtureSha256"] == candidate["fixtureSha256"],
        "tileGeometryMatches": [{key: row.get(key) for key in fields} for row in baseline["tileRecords"]] ==
                               [{key: row.get(key) for key in fields} for row in candidate["tileRecords"]],
        "totalsDeltaCandidateMinusBaseline": {key: candidate["totals"][key] - value
                                              for key, value in baseline["totals"].items()},
        "prefixCounterDeltaCandidateMinusBaseline": {key: candidate["prefixCounters"][key] - value
                                                     for key, value in baseline["prefixCounters"].items()},
    },
    "findings": [
        "Field CPU and uploads fell, but exact draw count, encoded pass-pixel visits, prefix accepted/declined lines and accepted pixels did not change.",
        "Candidate graph non-checkpoint wall time fell by about 2.59 s while admission CPU completion waiting grew by about 2.44 s. The nearly unchanged request wall time and worker active/idle samples are consistent with earlier arrival at the same GPU workload. They do not prove slower GPU execution.",
        "Candidate's 20 >100 ms admission fences total about 7.66 s. Every one is non-pressure maintenance with requiredBytes=0 and coordinateCount=0. Nineteen have 14 pooled resource candidates totaling 76,903,248 bytes; one has 16 totaling 85,423,568 bytes.",
        "These maintenance candidates exceed the 48 MiB reclaim batch threshold while working bytes remain below 75% of the 256 MiB budget. Completion cannot be skipped using the existing prior-frame proof when selected pool releases are stamped in the current epoch.",
        "Prefix-scratch's 20 terminal waits total 150.1 ms; that reason is not the full cost of prefix shaders. Prefix and other preceding GPU commands are also covered by admission queue-completion waits.",
        "Only 9 of 361,280 prefix lines decline in either run. Broad scalar fallback is not supported as the cause.",
        "Panning has five 389–433 ms admission waits in requests that subsequently report cancellation. Main-thread longtask observation records none during that stage; rAF delays alone cannot establish physical FPS or a synchronous main-thread cause.",
        "PresenterPayloadLedger observers call queue.onSubmittedWorkDone directly and are absent from QueueWaitStats/fence records. Their cost cannot be separated from these logs. Observed presenter counts show no active bitmap capture and a maximum 12,147,840 retiring bytes over the full candidate run.",
    ],
    "limits": [
        "Sequential diagnostic/profile-on runs, not a randomized profiler-off performance experiment.",
        "Queue wait is CPU wall time awaiting a GPU completion prefix, not shader GPU timestamp duration.",
        "Memory candidates are recorded before destruction and are not an exact count of reclaimed resources or physical VRAM.",
        "Encoded pass-pixel visits and prefix counters are work accounting, not mutually disjoint pixel totals.",
        "No source file or application behavior is modified by this analysis.",
    ],
}
(CANDIDATE / "diag-summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"output": str((CANDIDATE / "diag-summary.json").relative_to(ROOT)),
                  "comparison": report["comparison"], "candidateWaits": candidate["waits"],
                  "candidatePanWaits": candidate.get("panWaits")}, ensure_ascii=False, indent=2))
