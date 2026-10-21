#!/usr/bin/env python3
"""Read closed test SQLite snapshots and compare one FIG text export target.

This supplies separate identity evidence; it never edits results.json or relaxes
compare-visual.py. Databases are opened mode=ro, immutable=1, query_only=ON. A
nonempty WAL rejects rather than silently ignoring uncheckpointed state.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect(run):
    result_bytes = (run / "results.json").read_bytes()
    result = json.loads(result_bytes)
    export = result["exportVerification"]
    edit = result["extended"]["edit"]
    require(result["status"] == "completed" and export["status"] == "completed", "Run/export incomplete")
    require(result["fixture"].lower().endswith(".fig"), "Expected a FIG fixture")
    require(edit["undoRestoredCompleteDocument"] and edit["beforeSha256"] == edit["undoSha256"], "Whole-document undo missing")
    require(export["beforeDocumentSha256"] == export["afterDocumentSha256"] == edit["undoSha256"], "Export changed persisted document")
    require(export["sourceFilePreserved"], "Source fixture preservation missing")
    target = export["target"]
    require(target == result["anchor"] == edit["target"] and target["kind"] == "text", "Export/interaction target mismatch")
    databases = list((run / "profiles").glob("*/workspace-v1.sqlite3"))
    require(len(databases) == 1, "Expected exactly one owned workspace database")
    database = databases[0].resolve()
    wal = Path(str(database) + "-wal")
    require(not wal.exists() or wal.stat().st_size == 0, "Nonempty WAL: close/checkpoint through the owning app before reading")
    with sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        rows = connection.execute("SELECT d.id,d.head_revision,r.encoding,r.hash,r.snapshot,r.deleted "
            "FROM documents d JOIN revisions r ON r.document_id=d.id AND r.revision=d.head_revision").fetchall()
        matches = []
        for document_id, revision, encoding, stored_hash, snapshot, deleted in rows:
            if deleted:
                continue
            require(encoding == 2, "Unsupported snapshot encoding")
            envelope = json.loads(snapshot)
            require(envelope["format"] == "forma-workspace-snapshot" and envelope["version"] == 2, "Unsupported envelope")
            if target["id"] in envelope["document"]["nodes"]:
                matches.append((document_id, revision, stored_hash, snapshot, envelope))
        require(len(matches) == 1, "Target must occur in one live head snapshot")
        document_id, revision, stored_hash, snapshot, envelope = matches[0]
        initial = connection.execute("SELECT hash,snapshot FROM revisions WHERE document_id=? AND deleted=0 ORDER BY revision LIMIT 1",
            (document_id,)).fetchone()
        require(initial and initial[0] == stored_hash and initial[1] == snapshot, "Head snapshot differs from the pre-edit initial snapshot")
    document = envelope["document"]
    nodes = document["nodes"]
    node = nodes[target["id"]]
    require(node["name"] == target["name"] and node["kind"] == target["kind"] and not node["children"], "Expected the named leaf text")
    paths, descriptions = {}, {}
    for page_index, page in enumerate(document["pages"]):
        stack = [(identifier, (page_index, child_index), [{"pageIndex": page_index, "name": page["name"]}])
            for child_index, identifier in reversed(list(enumerate(page["children"])))]
        while stack:
            identifier, path, parents = stack.pop()
            require(identifier not in paths, "Ambiguous parent path or cycle")
            child = nodes[identifier]
            paths[identifier] = path
            descriptions[identifier] = parents + [{"childIndex": path[-1], "kind": child["kind"], "name": child["name"]}]
            stack.extend((value, path + (index,), descriptions[identifier])
                for index, value in reversed(list(enumerate(child["children"]))))
    require(target["id"] in paths, "Target is not reachable from a page")

    def semantic(value):
        # Remove only schema-known opaque identities. Arbitrary user metadata,
        # text, unknown fields and unrelated strings remain fully compared.
        normalized = json.loads(json.dumps(value))
        normalized.pop("id")
        normalized["children"] = [list(paths[identifier]) for identifier in value["children"]]
        for collection in ["fills", "strokes", "effects"]:
            for entry in normalized.get(collection, []):
                entry.pop("id", None)
        return normalized

    path = paths[target["id"]]
    ancestors = []
    page = document["pages"][path[0]]
    page_semantic = {key: value for key, value in page.items() if key not in ["id", "children"]}
    page_semantic["children"] = [list(paths[identifier]) for identifier in page["children"]]
    children = page["children"]
    chain_ids = []
    for index in path[1:]:
        identifier = children[index]
        chain_ids.append(identifier)
        ancestors.append(semantic(nodes[identifier]))
        children = nodes[identifier]["children"]
    # This narrow proof does not resolve asset placeholders in the target or
    # ancestor nodes. Reject such a route instead of comparing two nulls.
    for reference in envelope["resources"]:
        for identifier in chain_ids:
            escaped = identifier.replace("~", "~0").replace("/", "~1")
            require(not reference["pointer"].startswith("/nodes/" + escaped + "/"), "Target ancestry has external asset leaves")
    semantic_document = {"page": page_semantic, "ancestryIncludingTarget": ancestors,
        "documentSchemaVersion": document["schemaVersion"], "rasterProfile": document.get("rasterProfile"),
        "colorManagement": document.get("colorManagement"), "fonts": document.get("fonts")}
    exports = []
    for asset in export["assets"]:
        file = (run / asset["file"]).resolve()
        require(file.is_relative_to(run.resolve()), "Export path leaves its run directory")
        data = file.read_bytes()
        require(data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR", "Invalid PNG")
        size = [int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")]
        require(digest(data) == asset["sha256"] and len(data) == asset["byteLength"] and size == [asset["width"], asset["height"]], "Saved PNG disagrees with original result")
        exports.append({"scale": asset["scale"], "file": asset["file"], "size": size, "bytes": len(data), "sha256": digest(data)})
    require(sorted(asset["scale"] for asset in exports) == [1, 2, 3], "Expected 1x, 2x and 3x exports")
    evidence = {"run": run.name, "fixture": result["fixture"], "fixtureSha256": result["fixtureSha256"],
        "resultsSha256": digest(result_bytes), "target": target, "databaseRelativePath": str(database.relative_to(run.resolve())),
        "headRevision": revision, "headEqualsInitialSnapshot": True, "storedRevisionHash": stored_hash,
        "encodedSnapshotSha256": digest(snapshot),
        "sameNameKindCount": sum(value["name"] == target["name"] and value["kind"] == target["kind"] for value in nodes.values()),
        "targetTreePath": list(path), "targetPathDescription": descriptions[target["id"]],
        "sameNameKindCandidates": [descriptions[identifier] for identifier, value in nodes.items()
            if value["name"] == target["name"] and value["kind"] == target["kind"]],
        "targetSemanticSha256": digest(encoded(semantic(node))), "ancestrySemanticSha256": digest(encoded(semantic_document)),
        "targetSemantic": semantic(node), "exports": exports}
    return evidence, semantic_document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(args.output.name == "export-target-proof.json", "Output must be a separate export-target-proof.json, never an original run artifact")
    reference, a = inspect(args.reference)
    candidate, b = inspect(args.candidate)
    require(reference["fixtureSha256"] == candidate["fixtureSha256"], "Different FIG fixtures")
    require(reference["targetTreePath"] == candidate["targetTreePath"] and
        reference["targetPathDescription"] == candidate["targetPathDescription"], "Different structural targets")
    require(a == b, "Authored target/ancestor semantics differ after only known identity normalization")
    byte_comparisons = []
    for scale in [1, 2, 3]:
        left = next(asset for asset in reference["exports"] if asset["scale"] == scale)
        right = next(asset for asset in candidate["exports"] if asset["scale"] == scale)
        equal = (args.reference / left["file"]).read_bytes() == (args.candidate / right["file"]).read_bytes()
        require(equal, "Export bytes differ at scale " + str(scale))
        byte_comparisons.append({"scale": scale, "byteEqual": equal, "sha256": left["sha256"], "size": left["size"], "bytes": left["bytes"]})
    proof = {"schemaVersion": 1, "status": "proved-for-this-leaf-text-target", "reference": reference, "candidate": candidate,
        "databaseAccess": "mode=ro&immutable=1; PRAGMA query_only=ON; nonempty WAL refused",
        "normalization": ["node.id removed", "schema fills/strokes/effects entry id removed", "ordered child node references replaced by full page/child-index paths"],
        "treePathEqual": True, "targetAndAncestorSemanticsEqual": True, "exportBytesEqual": True,
        "targetIdsEqual": reference["target"]["id"] == candidate["target"]["id"], "exports": byte_comparisons,
        "strictCompareVisualGateChanged": False,
        "limitations": "This separate proof does not change the original target-ID gate, prove whole-document imported-ID equivalence, or establish motion clarity/FPS. Names alone are not unique."}
    args.output.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": proof["status"], "targetIdsEqual": proof["targetIdsEqual"], "treePath": reference["targetTreePath"],
        "sameNameKindCounts": [reference["sameNameKindCount"], candidate["sameNameKindCount"]], "semanticSha256": reference["targetSemanticSha256"],
        "ancestrySha256": reference["ancestrySemanticSha256"], "exports": byte_comparisons}, ensure_ascii=False))


if __name__ == "__main__":
    main()
