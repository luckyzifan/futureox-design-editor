"""Fixed visual metrics for different display tiers; exact PNG export gate.

Canvas metrics alone are report-only. --require-exact-canvas is the unchanged
zero-difference requirement for same-tier cache/control comparisons. No visual
pass threshold is inferred from these measurements.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("reference", type=Path)
parser.add_argument("candidate", type=Path)
parser.add_argument("--require-exact-canvas", action="store_true")
parser.add_argument("--require-exports", action="store_true")
args = parser.parse_args()
reference, candidate = args.reference, args.candidate


def load_report(directory):
    report = json.loads((directory / "results.json").read_text())
    if report.get("status") != "completed" or not report.get("presentationPassed"):
        raise RuntimeError(f"Incomplete presentation run: {directory.name}")
    if not report.get("navigationPreservedDocument"):
        raise RuntimeError(f"Navigation changed authored content: {directory.name}")
    if report.get("extendedEnabled"):
        extended = report.get("extended", {})
        if extended.get("status") != "completed" or not extended.get("wheel", {}).get("documentPreserved") \
                or not extended.get("edit", {}).get("undoRestoredCompleteDocument") \
                or not extended.get("sourceFilePreserved"):
            raise RuntimeError(f"Incomplete authored interaction/undo gate: {directory.name}")
    if not report.get("stages") or any(not s.get("settled", {}).get("ok") or s.get("actionError") for s in report["stages"]):
        raise RuntimeError(f"A recorded stage failed: {directory.name}")
    return report


reports = [load_report(directory) for directory in (reference, candidate)]
if reports[0].get("fixtureSha256") != reports[1].get("fixtureSha256"):
    raise RuntimeError("Fixture bytes differ")
if reports[0].get("captureMode", "DOM screenshot") != reports[1].get("captureMode", "DOM screenshot"):
    raise RuntimeError("Capture modes differ")
if [s["name"] for s in reports[0]["stages"]] != [s["name"] for s in reports[1]["stages"]]:
    raise RuntimeError("Recorded operation sequences differ")


def rgba(path):
    with Image.open(path) as image:
        if image.format != "PNG":
            raise RuntimeError(f"Not a PNG: {path.name}")
        result = np.asarray(image.convert("RGBA")).copy()
    if not result.shape[0] or not result.shape[1] or not np.any(result[..., 3]):
        raise RuntimeError(f"Empty transparent image: {path.name}")
    return result


def compare_canvas(left_path, right_path, name, kind="cross-run"):
    left, right = rgba(left_path), rgba(right_path)
    if left.shape != right.shape:
        raise RuntimeError(f"Different image extents: {name}: {left.shape}/{right.shape}")
    rgb = np.abs(left[..., :3].astype(np.int16) - right[..., :3].astype(np.int16))
    pixel_max = rgb.max(axis=-1)
    count = left.shape[0] * left.shape[1]
    gt4, gt16 = int((pixel_max > 4).sum()), int((pixel_max > 16).sum())
    return {"name": name, "kind": kind, "width": left.shape[1], "height": left.shape[0], "pixels": count,
            "differentRgbaPixels": int(np.any(left != right, axis=-1).sum()),
            "differentAlphaPixels": int((left[..., 3] != right[..., 3]).sum()),
            "rgbMean": float(rgb.mean()), "rgbP99": float(np.percentile(rgb, 99, method="linear")),
            "rgbMax": int(rgb.max()), "rgbGt4Pixels": gt4, "rgbGt4Fraction": gt4 / count,
            "rgbGt16Pixels": gt16, "rgbGt16Fraction": gt16 / count,
            "referenceRgbaSha256": hashlib.sha256(left.tobytes()).hexdigest(),
            "candidateRgbaSha256": hashlib.sha256(right.tobytes()).hexdigest()}


left_names = {p.name for p in reference.glob("*-canvas.png")}
right_names = {p.name for p in candidate.glob("*-canvas.png")}
if not left_names or left_names != right_names:
    raise RuntimeError(f"Canvas capture sets differ: reference-only={sorted(left_names-right_names)}, candidate-only={sorted(right_names-left_names)}")
rows = [compare_canvas(reference / name, candidate / name, name) for name in sorted(left_names)]
if len({r["referenceRgbaSha256"] for r in rows}) < 3:
    raise RuntimeError("Workload did not produce distinct content captures")
held = "held-drag-canvas-buffer.png"
if (reference / held).exists() != (candidate / held).exists():
    raise RuntimeError("Held-drag workloads differ")
if (candidate / held).exists():
    for label, directory in [("reference", reference), ("candidate", candidate)]:
        rows.append(compare_canvas(directory / held, directory / "settled-drag-canvas-buffer.png",
                                   f"{label}-held-vs-settled", "within-run"))

exports_requested = args.require_exports or any(r.get("verifyExportEnabled") or r.get("exportVerification") for r in reports)
export_rows = []


def validated_exports(directory, report):
    verification = report.get("exportVerification", {})
    expected_hash = report.get("extended", {}).get("edit", {}).get("undoSha256")
    if verification.get("status") != "completed" or verification.get("scales") != [1, 2, 3] \
            or not verification.get("documentPreserved") or not verification.get("sourceFilePreserved") \
            or not expected_hash or verification.get("beforeDocumentSha256") != expected_hash \
            or verification.get("afterDocumentSha256") != expected_hash:
        raise RuntimeError(f"Incomplete exact UI export/persistence gate: {directory.name}")
    assets = verification.get("assets", [])
    if len(assets) != 3 or sorted(a.get("scale", 0) for a in assets) != [1, 2, 3]:
        raise RuntimeError(f"Expected one PNG at each export scale: {directory.name}")
    checked = {}
    for asset in assets:
        scale = asset["scale"]
        relative = f"exports/selection-{scale}x.png"
        if asset.get("file") != relative or asset.get("mime") != "image/png":
            raise RuntimeError(f"Unexpected export artifact identity: {directory.name}/{relative}")
        data = (directory / relative).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        pixels = rgba(directory / relative)
        if asset.get("sha256") != digest or asset.get("byteLength") != len(data) \
                or asset.get("width") != pixels.shape[1] or asset.get("height") != pixels.shape[0] \
                or not asset.get("nontransparentPixels"):
            raise RuntimeError(f"Export evidence does not match saved PNG: {directory.name}/{relative}")
        checked[scale] = (asset, data, digest)
    return verification, checked


if exports_requested:
    left_export, left_assets = validated_exports(reference, reports[0])
    right_export, right_assets = validated_exports(candidate, reports[1])
    if left_export.get("target") != right_export.get("target"):
        raise RuntimeError("Exact exports target different original nodes")
    for scale in [1, 2, 3]:
        left, left_bytes, left_hash = left_assets[scale]
        right, right_bytes, right_hash = right_assets[scale]
        export_rows.append({"scale": scale, "referenceSha256": left_hash, "candidateSha256": right_hash,
                            "referenceBytes": len(left_bytes), "candidateBytes": len(right_bytes),
                            "referenceSize": [left["width"], left["height"]], "candidateSize": [right["width"], right["height"]],
                            "byteEqual": left_bytes == right_bytes})

canvas_exact = all(r["differentRgbaPixels"] == 0 for r in rows)
exports_exact = all(r["byteEqual"] for r in export_rows) if exports_requested else None
result = {"reference": reference.name, "candidate": candidate.name,
          "canvasGate": "exact-rgba-zero-difference" if args.require_exact_canvas else "report-only; visual review required",
          "metricDefinition": "Raw 8-bit PNG RGB differences, including transparent RGB; mean/p99 over components, gt4/gt16 fractions over pixels whose largest RGB-channel difference exceeds the fixed value. No visual acceptance threshold.",
          "canvasExact": canvas_exact, "comparisons": rows,
          "exportGate": "PNG-byte-equality" if exports_requested else "not-run",
          "exportsExact": exports_exact, "exports": export_rows}
(candidate / "visual-comparison.json").write_text(json.dumps(result, indent=2) + "\n")
if exports_requested:
    (candidate / "export-byte-comparison.json").write_text(json.dumps({"reference": reference.name,
        "candidate": candidate.name, "exact": exports_exact, "assets": export_rows}, indent=2) + "\n")
print(json.dumps({"canvasComparisons": len(rows), "canvasExact": canvas_exact,
                  "canvasGate": result["canvasGate"], "exportGate": result["exportGate"], "exportsExact": exports_exact}))
if (args.require_exact_canvas and not canvas_exact) or (exports_requested and not exports_exact):
    raise SystemExit(1)
