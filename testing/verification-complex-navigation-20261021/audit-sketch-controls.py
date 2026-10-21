#!/usr/bin/env python3
"""Read original Sketch and real imported snapshots; output aggregate numbers only."""
import argparse
from collections import Counter
from hashlib import sha256
import json
import math
from pathlib import Path
import sqlite3
import zipfile

IDENTITY = [1., 0., 0., 1., 0., 0.]
TOLERANCE = 1e-9


def digest(value):
    return sha256(value).hexdigest()


def concat(a, b):
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]]


def native_matrix(node):
    frame = node.get("frame", {})
    x, y, w, h = [float(frame.get(k, 0)) for k in ["x", "y", "width", "height"]]
    angle = -math.radians(node.get("rotation", 0))
    s, c = math.sin(angle), math.cos(angle)
    sx, sy = [-1. if node.get(k) else 1. for k in ["isFlippedHorizontal", "isFlippedVertical"]]
    a, b, cc, d = c*sx, s*sx, -s*sy, c*sy
    return [a, b, cc, d, x+w/2-a*w/2-cc*h/2, y+h/2-b*w/2-d*h/2]


def xy(value):
    if isinstance(value, str):
        return [float(x) for x in value.strip("{}").split(",")]
    return [float(value["x"]), float(value["y"])]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--document", required=True, type=Path)
    parser.add_argument("--previous-sqlite", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    original, original_world = {}, {}

    def visit(node, parent):
        ident = node.get("do_objectID")
        matrix = concat(parent, native_matrix(node))
        if ident:
            if ident in original:
                raise ValueError("Duplicate original identity")
            original[ident], original_world[ident] = node, matrix
        for child in node.get("layers", []):
            visit(child, matrix)

    with zipfile.ZipFile(args.source) as archive:
        for filename in archive.namelist():
            if filename.startswith("pages/") and filename.endswith(".json"):
                visit(json.loads(archive.read(filename)), IDENTITY)
    paths = {ident: node for ident, node in original.items() if node.get("_class") == "shapePath"}
    circle_ids = {ident for ident, node in paths.items() if "圆" in node.get("name", "")}

    def audit(document):
        nodes = document["nodes"]
        parents = {}
        for ident, node in nodes.items():
            for child in node.get("children", []):
                if child in parents:
                    raise ValueError("Imported graph has multiple parents")
                parents[child] = ident
        memo = {}

        def world(ident, stack=frozenset()):
            if ident in stack:
                raise ValueError("Imported parent cycle")
            if ident not in memo:
                parent = world(parents[ident], stack | {ident}) if ident in parents else IDENTITY
                memo[ident] = concat(parent, nodes[ident].get("transform", IDENTITY))
            return memo[ident]

        counts = Counter()
        max_anchor = max_control = max_affine = max_circle_affine = 0.
        circle_column_difference = circle_dot = circle_unit_error = 0.
        for ident, source in paths.items():
            counts["sourcePaths"] += 1
            circle = ident in circle_ids
            points = source.get("points", [])
            counts["sourceAnchors"] += len(points)
            counts["circlePaths"] += int(circle)
            closed = source.get("isClosed") is not False
            counts["sourceClosedPaths" if closed else "sourceOpenPaths"] += 1
            counts["rawActiveHandleFlags"] += sum(bool(p.get("hasCurve"+side)) for p in points for side in ["From", "To"])
            if ident not in nodes:
                counts["missingImportedPaths"] += 1
                continue
            counts["matchedImportedPaths"] += 1
            node = nodes[ident]
            net = node.get("network") or {}
            vertices = {p["id"]: p for p in net.get("vertices", [])}
            edges = {e["id"]: e for e in net.get("edges", [])}
            expected_edges = len(points) if closed else max(0, len(points)-1)
            bad_topology = len(vertices) != len(points) or len(edges) != expected_edges
            width, height = [float(source["frame"][key]) for key in ["width", "height"]]
            units = [1., 1.] if node.get("bindings", {}).get("sketchNormalizedCoordinates") == "true" else [width, height]
            changed = False
            for index, p in enumerate(points):
                actual = vertices.get(f"v{index}")
                expected = xy(p["point"])
                error = math.inf if actual is None else max(abs(actual[axis]-expected[i]*units[i]) for i, axis in enumerate(["x", "y"]))
                if math.isfinite(error):
                    max_anchor = max(max_anchor, error)
                if error > TOLERANCE:
                    counts["anchorCoordinateMismatches"] += 1
                    changed = True
            for index in range(expected_edges):
                next_index = (index+1) % len(points)
                edge = edges.get(f"e{index}", {})
                bad_topology |= edge.get("from") != f"v{index}" or edge.get("to") != f"v{next_index}"
                for key, p, side in [("c1", points[index], "From"), ("c2", points[next_index], "To")]:
                    actual = edge.get(key)
                    if p.get("hasCurve"+side):
                        counts["activeRenderedControlSlots"] += 1
                        expected = xy(p["curve"+side])
                        if actual is None:
                            counts["missingActiveControls"] += 1
                            counts["circleMissingActiveControls"] += int(circle)
                            changed = True
                        else:
                            error = max(abs(actual[axis]-expected[i]*units[i]) for i, axis in enumerate(["x", "y"]))
                            max_control = max(max_control, error)
                            if error > TOLERANCE:
                                counts["activeControlCoordinateMismatches"] += 1
                                changed = True
                    else:
                        counts["inactiveRenderedControlSlots"] += 1
                        if actual is not None:
                            counts["inactiveControlsInvented"] += 1
                            changed = True
            counts["topologyMismatchedPaths"] += int(bad_topology)
            changed |= bad_topology
            counts["controlOrTopologyMismatchedPaths"] += int(changed)
            counts["circleControlOrTopologyMismatchedPaths"] += int(circle and changed)
            actual_matrix, expected_matrix = world(ident), original_world[ident]
            error = max(abs(a-b) for a, b in zip(actual_matrix, expected_matrix))
            max_affine = max(max_affine, error)
            counts["worldAffineMismatchedPaths"] += int(error > TOLERANCE)
            if circle:
                counts["circleWorldAffinesCompared"] += 1
                max_circle_affine = max(max_circle_affine, error)
                counts["circleWorldAffineMismatches"] += int(error > TOLERANCE)
                a, b, c, d = actual_matrix[:4]
                u, v = a*a+b*b, c*c+d*d
                circle_column_difference = max(circle_column_difference, abs(u-v))
                circle_dot = max(circle_dot, abs(a*c+b*d))
                circle_unit_error = max(circle_unit_error, abs(u-1), abs(v-1))
        required_counts = ["missingImportedPaths", "anchorCoordinateMismatches", "missingActiveControls",
            "activeControlCoordinateMismatches", "inactiveControlsInvented", "topologyMismatchedPaths",
            "controlOrTopologyMismatchedPaths", "circleMissingActiveControls", "circleControlOrTopologyMismatchedPaths",
            "worldAffineMismatchedPaths", "circleWorldAffineMismatches"]
        for field in required_counts:
            counts.setdefault(field, 0)
        return {"passed": not any(counts[field] for field in required_counts), "counts": dict(sorted(counts.items())),
            "maximumAnchorCoordinateError": max_anchor, "maximumActiveControlCoordinateError": max_control,
            "maximumWorldAffineError": max_affine, "maximumCircleWorldAffineError": max_circle_affine,
            "maximumCircleWorldColumnSquaredDifference": circle_column_difference,
            "maximumCircleWorldColumnDot": circle_dot, "maximumCircleWorldUnitSquaredError": circle_unit_error}

    payload = args.document.read_bytes()
    current = json.loads(payload)
    current = current.get("document", current)
    result = {"scope": "Original source identity, point index and edge endpoints; all original shapePath nodes, including hidden/open paths. Numeric aggregate output only.",
        "sourceFixtureSha256": digest(args.source.read_bytes()), "freshActualImportedFileSha256": digest(payload),
        "coordinateTolerance": TOLERANCE, "circleSubsetMeaning": "Source circle/arc labels select the diagnostic subset; all source shapePath geometry is independently audited without label-based reconstruction.",
        "freshImport": audit(current), "savedDocumentsAutomaticallyModified": False}
    if args.previous_sqlite:
        database = sqlite3.connect(args.previous_sqlite.resolve().as_uri()+"?mode=ro", uri=True)
        previous = None
        for (snapshot,) in database.execute("SELECT snapshot FROM revisions ORDER BY revision ASC"):
            old = json.loads(snapshot)
            old = old.get("document", old)
            if paths.keys() <= old.get("nodes", {}).keys():
                previous = old
                result["previousStoredSnapshotSha256"] = digest(snapshot)
                break
        database.close()
        if previous is None:
            raise ValueError("Previous snapshot did not contain all original paths")
        result["previousStoredImport"] = audit(previous)
        old, new = result["previousStoredImport"]["counts"], result["freshImport"]["counts"]
        result["comparison"] = {"missingActiveControlsRestored": old["missingActiveControls"]-new["missingActiveControls"],
            "inactiveInventedControlsRemoved": old["inactiveControlsInvented"]-new["inactiveControlsInvented"]}
    proof_root = args.output.parent
    for folder, label in [("gpu-circle-fixed-v2", "actualGpuFixed"), ("gpu-circle-old-network-control", "actualGpuBrokenNetworkNegativeControl")]:
        file = proof_root / folder / "circle-result.json"
        if file.exists():
            proof = json.loads(file.read_text())
            fields = ["backend", "width", "height", "wasmSha256", "pngSha256", "rawSha256", "nonfinite", "radialDirections", "radialMaximum", "radialPassed"]
            result[label] = {key: proof.get(key) for key in fields}
            result[label]["geometry"] = {key: proof.get("geometry", {}).get(key) for key in ["activeHandles", "mismatchedHandles", "inactiveHandlesInvented"]}
    args.output.write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps({"freshImport": result["freshImport"], "comparison": result.get("comparison")}))
    if not result["freshImport"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
