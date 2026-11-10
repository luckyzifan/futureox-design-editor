#!/usr/bin/env python3
"""Generate portable font-test subsets from the already bundled font.

Dependency: Python >= 3.10 and testing/font-fixtures-requirements.txt.
No downloads, installation, source writes, or historical fixture reads occur.
The original subset options are retained; recalcTimestamp=False makes output
bytes deterministic instead of encoding the generation wall-clock time.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
FONTTOOLS_VERSION = "4.61.1"
SOURCE_SHA256 = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
SOURCE_BYTES = 17_772_300
SUBSETS = [
    {
        "file": "noto-latin.ttf",
        "glyphSubset": " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        "bytes": 23_028,
        "sha256": "32924279319ac4b9bd7c2a11512be33a0f77985c54a3b97ffd4f37fa15abdceb",
    },
    {
        "file": "noto-cjk.ttf",
        "glyphSubset": " 中文测试继续文字",
        "bytes": 7_000,
        "sha256": "d364933e29d565ae7422d38abccd6965244246a917d31e1c1c531054a77fab8e",
    },
]
MANIFEST = {
    "schemaVersion": 1,
    "source": "frontend/design-client/public/fonts/NotoSansSC.ttf",
    "sourceSha256": SOURCE_SHA256,
    "sourceBytes": SOURCE_BYTES,
    "fontToolsVersion": FONTTOOLS_VERSION,
    "options": {"name_IDs": ["*"], "name_legacy": True, "name_languages": ["*"], "recalcTimestamp": False},
    "fonts": SUBSETS,
}


def require_fonttools():
    if sys.version_info < (3, 10):
        raise RuntimeError("Font fixture generation requires Python >= 3.10")
    try:
        import fontTools
    except ImportError as error:
        raise RuntimeError("Missing fontTools. Install the pinned dependency with: python -m pip install -r testing/font-fixtures-requirements.txt (no automatic installation is performed)") from error
    if fontTools.__version__ != FONTTOOLS_VERSION:
        raise RuntimeError(f"Font fixture generation requires fontTools=={FONTTOOLS_VERSION}; found {fontTools.__version__}. Install testing/font-fixtures-requirements.txt; no fallback or skip is permitted")
    from fontTools import subset
    from fontTools.ttLib import TTFont
    return subset, TTFont


def verify(directory: Path, TTFont):
    if not directory.is_dir() or directory.is_symlink():
        raise RuntimeError(f"Invalid generated font cache directory: {directory}")
    manifest = directory / "manifest.json"
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 16_384:
        raise RuntimeError(f"Invalid generated font cache manifest: {manifest}")
    if json.loads(manifest.read_text(encoding="utf-8")) != MANIFEST:
        raise RuntimeError(f"Generated font cache manifest mismatch: {manifest}")
    for record in SUBSETS:
        path = directory / record["file"]
        if path.is_symlink() or not path.is_file() or path.stat().st_size != record["bytes"]:
            raise RuntimeError(f"Generated font fixture size/type mismatch: {path}")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise RuntimeError(f"Generated font fixture SHA-256 mismatch: {path}")
        with TTFont(io.BytesIO(data), recalcTimestamp=False) as font:
            if set(font.getBestCmap() or {}) != {ord(char) for char in record["glyphSubset"]}:
                raise RuntimeError(f"Generated font fixture glyph coverage mismatch: {path}")


def generate(source: Path, cache_root: Path):
    subset, TTFont = require_fonttools()  # Cached bytes never conceal a missing/wrong dependency.
    source = source.resolve()
    if not source.is_file() or source.stat().st_size != SOURCE_BYTES:
        raise RuntimeError(f"Bundled source font missing or wrong size: {source}; expected {SOURCE_BYTES} bytes and SHA-256 {SOURCE_SHA256}")
    source_bytes = source.read_bytes()  # Read once, bounded by the exact size above.
    if len(source_bytes) != SOURCE_BYTES or hashlib.sha256(source_bytes).hexdigest() != SOURCE_SHA256:
        raise RuntimeError(f"Bundled source font SHA-256 mismatch: {source}; expected {SOURCE_SHA256}")
    # macOS /tmp and /var may be symlinks. Validate the real destination,
    # but return the caller's absolute spelling so cache identities stay stable.
    real_cache_root = cache_root.resolve()
    cache_root = cache_root.absolute()
    try:
        real_cache_root.relative_to(ROOT)
    except ValueError:
        pass
    else:
        raise RuntimeError("Font fixture cache must be outside the source checkout")
    cache_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = cache_root / f"font-batch-v1-{SOURCE_SHA256[:16]}-ft{FONTTOOLS_VERSION}"
    if destination.exists():
        try:
            verify(destination, TTFont)
        except Exception as error:
            raise RuntimeError(f"Generated cache is invalid; remove only this generated directory and retry: {destination}. {error}") from error
        return destination
    staging = Path(tempfile.mkdtemp(prefix=".font-staging-", dir=cache_root))
    try:
        for record in SUBSETS:
            # Re-open the captured bytes per subset, so no previous subset or
            # concurrent process can change the input. No timestamps are rewritten.
            with TTFont(io.BytesIO(source_bytes), recalcTimestamp=False) as font:
                options = subset.Options()
                options.name_IDs = ["*"]
                options.name_legacy = True
                options.name_languages = ["*"]
                worker = subset.Subsetter(options=options)
                worker.populate(text=record["glyphSubset"])
                worker.subset(font)
                font.save(staging / record["file"])
        (staging / "manifest.json").write_bytes((json.dumps(MANIFEST, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8"))
        verify(staging, TTFont)
        try:
            # Directory rename publishes both verified files and the manifest
            # atomically. Concurrent generators may race, but never see half files.
            staging.rename(destination)
        except OSError:
            if not destination.exists():
                raise
            verify(destination, TTFont)
        verify(destination, TTFont)
        return destination
    finally:
        if staging.exists():
            shutil.rmtree(staging)  # Only this invocation's private staging directory.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / MANIFEST["source"])
    parser.add_argument("--cache-root", type=Path, default=Path(tempfile.gettempdir()) / "core-font-test-fixtures")
    args = parser.parse_args()
    try:
        destination = generate(args.source, args.cache_root)
    except Exception as error:
        print(f"Font fixture generation failed: {error}", file=sys.stderr)
        return 1
    # Stdout may use an ASCII pipe encoding on otherwise supported platforms.
    # Escape JSON strings for transport; manifest file bytes remain UTF-8.
    print(json.dumps({"directory": str(destination), "manifest": MANIFEST}, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
