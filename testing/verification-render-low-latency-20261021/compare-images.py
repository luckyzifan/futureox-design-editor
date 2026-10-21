"""Lossless RGBA comparison, including RGB when alpha is unchanged/zero."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

reference, candidate = map(Path, sys.argv[1:3])
allow_baseline_undo = sys.argv[3:] == ["--known-baseline-undo-save-failure"]
if sys.argv[3:] and not allow_baseline_undo:
    raise RuntimeError("Unknown comparison option")
rows = []
baseline_limit = None
for directory in [reference, candidate]:
    report = json.loads((directory / "results.json").read_text())
    if report.get("status") != "completed":
        errors = report.get("errors", [])
        stages = report.get("stages", [])
        known = directory == reference and allow_baseline_undo and report.get("status") == "failed" \
            and len(stages) == 12 and all(stage.get("settled", {}).get("ok") and not stage.get("actionError") for stage in stages) \
            and len(errors) == 1 and errors[0].get("phase") == "extended-undo-edit" \
            and "Undo must restore the entire persisted document JSON" in errors[0].get("error", "")
        if not known:
            raise RuntimeError(f"Incomplete run: {directory.name}")
        expected = json.loads((directory / "undo-expected-document.json").read_text())
        actual = json.loads((directory / "undo-actual-document.json").read_text())
        edit = report["extended"]["edit"]
        target = edit["target"]["id"]
        if actual["nodes"][target]["transform"] != edit["afterTransform"] or expected["nodes"][target]["transform"] != edit["beforeTransform"]:
            raise RuntimeError("Baseline no longer matches the diagnosed persisted-undo failure")
        corrected = json.loads(json.dumps(actual))
        corrected["nodes"][target]["transform"] = expected["nodes"][target]["transform"]
        if corrected != expected:
            raise RuntimeError("Baseline failure includes changes beyond the diagnosed transform")
        before = np.asarray(Image.open(directory / "extended-select-edit-target-canvas.png").convert("RGBA"))
        undone = np.asarray(Image.open(directory / "extended-undo-edit-canvas.png").convert("RGBA"))
        if before.shape != undone.shape or not np.array_equal(before, undone):
            raise RuntimeError("The known baseline must still restore its exact visible pixels")
        baseline_limit = "Rendering-only reference: baseline undo restores the pixels but fails to save the original transform. The failed run is preserved. Candidate must complete persisted-document undo."
reference_mode = json.loads((reference / "results.json").read_text()).get("captureMode", "DOM screenshot")
candidate_mode = json.loads((candidate / "results.json").read_text()).get("captureMode", "DOM screenshot")
if reference_mode != candidate_mode:
    raise RuntimeError("Capture modes differ; compare matching DOM screenshots or matching compositor buffers")


def compare(a, b, name):
    left = np.asarray(Image.open(a).convert("RGBA"))
    right = np.asarray(Image.open(b).convert("RGBA"))
    if left.shape != right.shape:
        raise RuntimeError(f"Different image extents: {name}: {left.shape}/{right.shape}")
    different = int(np.any(left != right, axis=-1).sum())
    if not np.any(left[..., 3]) or not np.any(right[..., 3]):
        raise RuntimeError(f"Empty transparent capture: {name}")
    rows.append({"name": name, "width": left.shape[1], "height": left.shape[0],
                 "pixels": left.shape[0] * left.shape[1], "differentPixels": different,
                 "referenceRgbaSha256": hashlib.sha256(left.tobytes()).hexdigest(),
                 "candidateRgbaSha256": hashlib.sha256(right.tobytes()).hexdigest()})


for a in sorted(reference.glob("*-canvas.png")):
    b = candidate / a.name
    if not b.exists():
        raise RuntimeError(f"Missing candidate image: {a.name}")
    compare(a, b, a.name)
held = candidate / "held-drag-canvas-buffer.png"
if held.exists():
    compare(held, candidate / "settled-drag-canvas-buffer.png", "held-vs-settled-buffer")
if not rows:
    raise RuntimeError("No image comparisons")
if len({row["referenceRgbaSha256"] for row in rows}) < 3:
    raise RuntimeError("Workload did not produce distinct content captures")
result = {"reference": reference.name, "candidate": candidate.name, "comparisons": rows,
          "differentPixels": sum(row["differentPixels"] for row in rows)}
if baseline_limit:
    result["baselineLimitation"] = baseline_limit
(candidate / "pixel-comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"comparisons": len(rows), "differentPixels": result["differentPixels"]}))
if result["differentPixels"]:
    raise SystemExit(1)
