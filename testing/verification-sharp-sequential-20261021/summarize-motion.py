#!/usr/bin/env python3
"""Summarize existing owned Electron motion evidence; never runs an app/test.

Usage: python3 summarize-motion.py RUN_DIRECTORY [RUN_DIRECTORY ...] --out FILE
Run indexes follow argument order. Output contains allowlisted numeric/boolean
measurements only, with no paths, document/paint names, URLs, pixels or messages.
Worker CPU completion waits are not exclusive shader execution or scanout time.
Percentiles use the nearest-rank convention; missing values remain null.
A livePreview success (even previewTiles=1) is not itself a sequential-frame
certificate. The separately scoped driver counter is retained for reconciliation.
"""
import argparse
import collections
import json
import math
from pathlib import Path


EVENTS = frozenset(("request", "result", "error", "queue-enqueue", "queue-start", "queue-end",
    "compile-start", "compile", "hydrate-start", "hydrate", "fence", "skip", "cancel", "cache",
    "camera-input", "camera-request", "camera-submit", "preparation", "load-stage", "tile",
    "device-lifecycle", "prepare-wait", "cache-invalidate", "viewport-state", "stale-drop"))
SOURCES = frozenset(("main", "worker", "host"))


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def scalar(value):
    return round(value, 6) if number(value) else None


def stats(values):
    values = sorted(value for value in values if number(value) and value >= 0)
    def percentile(fraction):
        return scalar(values[max(0, math.ceil(len(values) * fraction) - 1)]) if values else None
    return {"count": len(values), "sumMs": scalar(sum(values)), "p50Ms": percentile(.5),
        "p95Ms": percentile(.95), "maxMs": scalar(values[-1]) if values else None}


def numeric_stats(values):
    values = sorted(value for value in values if number(value) and value >= 0)
    return {"count": len(values), "sum": scalar(sum(values)),
        "min": scalar(values[0]) if values else None, "max": scalar(values[-1]) if values else None}


def events(path):
    rows = []
    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            if isinstance(value.get("event"), str) and value["event"] in EVENTS and \
                    isinstance(value.get("source"), str) and value["source"] in SOURCES and all(
                    number(value.get(key)) for key in ("session", "seq", "at")):
                rows.append(value)
            else:
                for item in value.values():
                    walk(item)
    decoder = json.JSONDecoder()
    for line in path.read_text().splitlines():
        start = line.find("{")
        if start >= 0:
            try:
                walk(decoder.raw_decode(line[start:])[0])
            except json.JSONDecodeError:
                pass
    unique = {(row["session"], row["source"], row["seq"]): row for row in rows}
    return sorted(unique.values(), key=lambda row: (row["at"], row["seq"])), len(rows)


def pool_only(row):
    return row.get("reasonCode") == 6 and row.get("admissionKind") == 0 and \
        row.get("admissionRequiredBytes") == 0 and row.get("admissionPressure") == 0 and \
        row.get("admissionRetiredKinds") == 1 and row.get("admissionRetiredUploadCount") == 0 and \
        row.get("admissionCoordinateCount") == 0 and row.get("admissionPoolCount", 0) > 0 and \
        number(row.get("admissionWorkingBytes")) and number(row.get("admissionBudgetBytes")) and \
        row["admissionWorkingBytes"] <= row["admissionBudgetBytes"] * .75


def fence_summary(rows):
    fences = [row for row in rows if row.get("source") == "worker" and row.get("event") == "fence"]
    reasons = sorted({int(row["reasonCode"]) for row in fences if number(row.get("reasonCode"))})
    admission = [row for row in fences if row.get("reasonCode") == 6]
    retired_kinds = sorted({int(row["admissionRetiredKinds"]) for row in admission if number(row.get("admissionRetiredKinds"))})
    return {"all": stats(row.get("queueWaitMs") for row in fences),
        "byReason": {str(reason): stats(row.get("queueWaitMs") for row in fences if row.get("reasonCode") == reason)
            for reason in reasons},
        "admissionByRetiredKinds": {str(kind): stats(row.get("queueWaitMs") for row in admission
            if row.get("admissionRetiredKinds") == kind) for kind in retired_kinds},
        "admissionPressure": stats(row.get("queueWaitMs") for row in admission if row.get("admissionPressure") == 1),
        "admissionWithCoordinates": stats(row.get("queueWaitMs") for row in admission if row.get("admissionCoordinateCount", 0) > 0),
        "admissionWithRetiredUploads": stats(row.get("queueWaitMs") for row in admission if row.get("admissionRetiredUploadCount", 0) > 0),
        "poolOnlyNoPressureAtMost75Percent": stats(row.get("queueWaitMs") for row in fences if pool_only(row)),
        "poolOnlyEligibleMaxWorkingBytes": max((row["admissionWorkingBytes"] for row in fences if pool_only(row)), default=None),
        "poolOnlyEligibleMaxPoolBytes": max((row.get("admissionPoolBytes", 0) for row in fences if pool_only(row)), default=None)}


def identity(row):
    return row.get("session"), row.get("requestId")


def outcome(rows):
    worker_errors = [row for row in rows if row.get("source") == "worker" and row.get("event") == "error"]
    if any(row.get("source") == "main" and row.get("event") == "result" for row in rows):
        return "success"
    if any(row.get("failureCode") == 65 for row in worker_errors):
        return "unsupported"
    if any(row.get("failureCategory") == 1 for row in worker_errors):
        return "workerCancelled"
    if worker_errors:
        return "otherWorkerError"
    if any(row.get("source") == "main" and row.get("event") == "cancel" for row in rows):
        return "clientCancelledWithoutWorkerOutcome"
    if any(row.get("source") == "main" and row.get("event") == "error" for row in rows):
        return "otherMainError"
    return "pending"


def group_summary(requests, indexed, start, input_end, end):
    groups = collections.defaultdict(list)
    for key, request in requests.items():
        groups[outcome(indexed[key])].append(key)
    summaries = {}
    for category, keys in groups.items():
        rows = [row for key in keys for row in indexed[key]]
        worker = [row for row in rows if row.get("source") == "worker"]
        cancelled = [row for row in worker if row.get("event") == "error" and row.get("failureCategory") == 1]
        summary = {"count": len(keys),
            "compile": stats(row.get("durationMs") for row in worker if row.get("event") == "compile"),
            "hydrate": stats(row.get("durationMs") for row in worker if row.get("event") == "hydrate"),
            "queueBody": stats(row.get("durationMs") for row in worker if row.get("event") == "queue-end"),
            "cancelStages": dict(sorted(collections.Counter(str(int(row.get("failureStage", 0))) for row in cancelled).items())),
            "fences": fence_summary(worker)}
        summaries[category] = summary
    main_results = [row for key in requests for row in indexed[key]
        if row.get("source") == "main" and row.get("event") == "result"]
    return {"count": len(requests), "authoredEnvelopeCount": sum(row.get("documentEnvelope") == 1 for row in requests.values()),
        "startedBeforeLastInputCount": sum(row["at"] <= input_end for row in requests.values()),
        "completedBeforeLastInputCount": sum(row["at"] <= input_end for row in main_results),
        "successfulCompletionRelativeMs": [scalar(row["at"] - start) for row in main_results],
        "successfulRequestIds": [row["requestId"] for row in main_results],
        "previewTilesEqualOneCount": sum(row.get("previewTiles") == 1 for row in main_results),
        "outcomes": summaries,
        "resultStages": {key: stats(row.get(key) for row in main_results) for key in
            ("milliseconds", "compileMs", "graphMs", "finishMs", "checkpointMs", "pipelineWallMs")},
        "resultMaterialFields": {key: numeric_stats(row.get(key) for row in main_results) for key in
            ("materialFieldBuilds", "materialFieldHits", "materialFieldUploadBytes", "imageAxisFields", "imageFieldBytes")},
        "resultMaterialFieldBuildElapsed": stats(row.get("materialFieldBuildMs") for row in main_results)}


def summarize(path, index):
    report = json.loads((path / "results.json").read_text())
    trace = json.loads((path / "zoom-trace.json").read_text())
    start, end = trace["startAt"], trace["endAt"]
    if not number(start) or not number(end) or end < start:
        raise ValueError("Invalid measured window")
    input_times = [row.get("at") for row in trace.get("inputs", []) if number(row.get("at"))]
    input_end = max(input_times, default=start)
    all_rows, raw_count = events(path / "host-stdout.log")
    measured = [row for row in all_rows if start <= row["at"] <= end]
    requests = {identity(row): row for row in measured if row.get("source") == "main" and
        row.get("event") == "request" and row.get("commandCode") == 1 and number(row.get("requestId"))}
    indexed = collections.defaultdict(list)
    for row in measured:
        if identity(row) in requests:
            indexed[identity(row)].append(row)
    whole = {key: row for key, row in requests.items() if row.get("livePreview") == 1 and not row.get("tileViewport")}
    tiles = {key: row for key, row in requests.items() if row.get("tileViewport") == 1}
    rejected = [row for row in measured if row.get("source") == "worker" and row.get("event") == "skip"
        and number(row.get("reasonCode")) and 601 <= row["reasonCode"] <= 613]
    rejected_keys = {identity(row) for row in rejected}
    reasons = {}
    for code in range(601, 614):
        rows = [row for row in rejected if row["reasonCode"] == code]
        if rows:
            reasons[str(code)] = {"count": len(rows), "requestCount": len({identity(row) for row in rows}),
                "states": dict(sorted(collections.Counter(str(int(row["state"])) for row in rows if number(row.get("state"))).items())),
                "candidateCounts": dict(sorted(collections.Counter(str(int(row["count"])) for row in rows if number(row.get("count"))).items()))}
    gate = report.get("gate", {})
    gate_output = {key: value for key, value in gate.items() if key in ("expectedSharp", "passed", "maxAckLagMs",
        "tolerance", "acknowledgementCount", "motionAcknowledgements", "settlingAcknowledgements", "measuredQualityCount",
        "minimumSharpCoverage", "maximumUpscale", "maximumRequestedZoom", "maximumAcknowledgedZoom") and
        (number(value) or isinstance(value, bool))}
    gate_output["violationCount"] = len(gate.get("violations", []))
    for key in ("inputToAckMs", "requestToAckMs", "actualInputGapsMs"):
        gate_output[key] = {field: scalar(gate.get(key, {}).get(field)) for field in ("p50", "p95", "max")}
    memory = report.get("gpuMemory") or {}
    policy = memory.get("rendererPolicy") or {}
    driver = memory.get("driverStats") or {}
    counter = policy.get("sequentialDisplayFrames")
    whole_successes = sum(outcome(indexed[key]) == "success" for key in whole)
    lifetime_requests = {identity(row): row for row in all_rows if row.get("source") == "main" and
        row.get("event") == "request" and row.get("commandCode") == 1 and row.get("livePreview") == 1 and not row.get("tileViewport")}
    lifetime_indexed = collections.defaultdict(list)
    for row in all_rows:
        if identity(row) in lifetime_requests:
            lifetime_indexed[identity(row)].append(row)
    outside_successes = sum(outcome(lifetime_indexed[key]) == "success" for key in lifetime_requests if key not in whole)
    unsupported = [key for key in whole if outcome(indexed[key]) == "unsupported"]
    cancellations = [row for row in measured if row.get("source") == "main" and row.get("event") == "cancel"]
    cancel_delays = [row["at"] - requests[identity(row)]["at"] for row in cancellations if identity(row) in requests]
    return {"index": index, "window": {"startAt": start, "endAt": end, "lastInputAt": input_end,
            "durationMs": scalar(end - start), "inputDurationMs": scalar(input_end - start)},
        "gate": gate_output, "events": {"rawLifetimeCount": raw_count, "deduplicatedLifetimeCount": len(all_rows),
            "measuredCount": len(measured), "workerErrorCount": sum(row.get("source") == "worker" and row.get("event") == "error" for row in measured)},
        "wholePreview": group_summary(whole, indexed, start, input_end, end),
        "ordinaryTiles": group_summary(tiles, indexed, start, input_end, end),
        "mainCancellation": {"count": len(cancellations), "requestToCancel": stats(cancel_delays)},
        "fences": fence_summary(measured), "rejections": reasons,
        "unsupportedWholeRequestsWithoutDetailedRejection": sum(key not in rejected_keys for key in unsupported),
        "rejectionDiagnosticLifetimeLimit": 64,
        "rendererCounterObservation": {"available": number(counter), "sequentialDisplayFrames": scalar(counter),
            "counterIsDriverLifetime": True, "successfulMeasuredWholeRequests": whole_successes,
            "successfulWholeRequestsOutsideMeasuredWindow": outside_successes,
            "counterEqualsSuccessfulMeasuredWholeRequests": counter == whole_successes if number(counter) else None,
            "counterEqualityDoesNotIndependentlyProvePhaseOrSequentialMode": True,
            "readbackBytes": scalar(driver.get("rasterReadbackBytes")), "crossDeviceBitmaps": scalar(driver.get("crossDeviceBitmaps")),
            "workingBudgetBytes": scalar(policy.get("workingBudgetBytes")), "deviceLost": memory.get("deviceLost")
                if isinstance(memory.get("deviceLost"), bool) else None,
            "memoryObservationErrorCount": len((report.get("gpuMemoryObservation") or {}).get("errors", []))}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", nargs="+", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    value = {"version": 1, "runs": [summarize(path, index) for index, path in enumerate(args.runs)]}
    output = json.dumps(value, indent=2, allow_nan=False) + "\n"
    if args.out:
        args.out.write_text(output)
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
