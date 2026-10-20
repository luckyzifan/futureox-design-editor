#!/usr/bin/env python3
"""Summarize existing captures without launching the app or running any tests."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNS = ("candidate1-117", "candidate1-fig", "candidate2-117", "candidate2-fig")


def stage(value):
    keys = ("name", "wallStart", "wallEnd", "actionMs", "totalMs", "actionError",
            "raf", "longtasks", "profilerErrors")
    row = {key: value[key] for key in keys if key in value}
    row["settled"] = value.get("settled", {}).get("ok")
    row["settleError"] = value.get("settled", {}).get("error")
    return row


summaries = []
for name in RUNS:
    raw = (ROOT / name / "results.json").read_bytes()
    result = json.loads(raw)
    keys = ("fixtureSha256", "startedAt", "scope", "sampling", "extendedEnabled",
            "adapter", "document", "navigationPreservedDocument", "status")
    summary = {"run": name, "rawResultSha256": hashlib.sha256(raw).hexdigest(),
               **{key: result[key] for key in keys if key in result},
               "stages": [stage(value) for value in result["stages"]]}
    if result.get("extended"):
        extended = result["extended"]
        summary["extended"] = {
            key: extended[key] for key in
            ("status", "scope", "cpuProfiling", "persistenceReadsOutsideProfiles",
             "sourceFilePreserved") if key in extended
        }
        summary["extended"]["stages"] = extended.get("stages", [])
        # Keep correctness outcomes without document payloads or host configuration.
        for key, fields in (
            ("wheel", ("deltas", "observedZooms", "documentSha256", "documentPreserved")),
            ("edit", ("mode", "beforeSha256", "afterSha256", "undoSha256",
                      "changed", "nodeCountPreserved", "undoRestoredCompleteDocument")),
        ):
            if key in extended:
                summary["extended"][key] = {
                    field: extended[key][field] for field in fields
                    if field in extended[key]
                }
    summaries.append(summary)

output = {
    "scope": "Historical captures from before the canvas UI merge; no new runs. "
             "Not acceptance of merged source, frame rate or input latency. "
             "Raw profiles, screenshots, host configuration and imported files stay local.",
    "runs": summaries,
}
(ROOT / "candidate-summary.json").write_text(
    json.dumps(output, ensure_ascii=False, indent=2) + "\n"
)
