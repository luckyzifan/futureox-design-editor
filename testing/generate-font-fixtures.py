#!/usr/bin/env python3
"""Build Noto Sans SC subsets for the design-client font tests.

The bundled variable font stays in the checkout. Subsets are published only
under --cache-root, after the source size and SHA-256 match. fontTools is
never installed from here; install testing/font-fixtures-requirements.txt
first. Serialization uses fontTools' pure-Python packer so an optional
uharfbuzz install cannot change the bytes.

font-test-fixtures.test.ts also pins historical subset SHA-256 values. Those
bytes were never committed, and this recipe does not reproduce them.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import uuid
from pathlib import Path

SOURCE_BYTES = 17_772_300
SOURCE_SHA256 = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
FONTTOOLS_VERSION = "4.61.1"
# fonts[1] is the CJK record. The leading space and the repeated 文 are part of
# the subset text recorded in the manifest, not a sorted cmap dump.
SUBSETS = (
    ("noto-latin", "ABC"),
    ("noto-cjk", " 中文测试继续文字"),
)
CACHE_NAME = "noto-sans-sc-" + SOURCE_SHA256[:32] + "-fonttools-" + FONTTOOLS_VERSION
REQUIREMENTS = "testing/font-fixtures-requirements.txt"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def require_fonttools():
    if sys.version_info < (3, 10):
        fail(f"Requires Python >= 3.10; found {sys.version.split()[0]}; no fallback or skip")
    try:
        import fontTools
    except ImportError:
        fail(
            "Missing fontTools. Install "
            f"{REQUIREMENTS}; no automatic installation"
        )
    found = getattr(fontTools, "__version__", "unknown")
    if found != FONTTOOLS_VERSION:
        fail(f"requires fontTools=={FONTTOOLS_VERSION}; found {found}; no fallback or skip")
    # Import after the version check. A stub package can report a version
    # without providing subset, and a broken subset module must surface as-is.
    import fontTools.subset as subset

    return subset


def default_source() -> Path:
    return Path(__file__).resolve().parents[1] / "frontend/design-client/public/fonts/NotoSansSC.ttf"


def read_source(path: Path) -> bytes:
    try:
        data = path.read_bytes() if path.is_file() else b""
    except OSError:
        data = b""
    if len(data) != SOURCE_BYTES:
        fail("Bundled source font missing or wrong size")
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        fail("Bundled source font SHA-256 mismatch")
    return data


def subset_font(subset, source: Path, text: str) -> bytes:
    options = subset.Options()
    options.harfbuzz_repacker = False
    options.recalc_timestamp = False
    # Copy the mutable defaults before any later assignment can alias them.
    options.drop_tables = list(options.drop_tables)
    options.layout_features = list(options.layout_features)
    options.name_IDs = list(options.name_IDs)
    options.name_languages = list(options.name_languages)
    options.hinting_tables = list(options.hinting_tables)
    font = subset.load_font(str(source), options, dontLoadGlyphNames=not options.glyph_names)
    job = subset.Subsetter(options=options)
    job.populate(text=text)
    job.subset(font)
    buffer = io.BytesIO()
    subset.save_font(font, buffer, options)
    font.close()
    return buffer.getvalue()


def manifest_for(files: dict[str, bytes]) -> dict:
    fonts = []
    for name, text in SUBSETS:
        blob = files[name]
        fonts.append({
            "file": f"{name}.ttf",
            "glyphSubset": text,
            "bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
        })
    return {
        "schemaVersion": 1,
        "sourceSha256": SOURCE_SHA256,
        "sourceBytes": SOURCE_BYTES,
        "fontToolsVersion": FONTTOOLS_VERSION,
        "fonts": fonts,
    }


def dump_manifest(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, ensure_ascii=True) + "\n"


def verify(directory: Path) -> dict:
    manifest_path = directory / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        fonts = manifest["fonts"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        fail("Generated cache is invalid: manifest unreadable; SHA-256 mismatch")
    if not isinstance(fonts, list):
        fail("Generated cache is invalid: manifest fonts are unusable; SHA-256 mismatch")
    for font in fonts:
        try:
            path = directory / font["file"]
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
        except (OSError, KeyError, TypeError):
            fail("Generated cache is invalid: font unreadable; SHA-256 mismatch")
        if digest != font.get("sha256") or len(data) != font.get("bytes"):
            fail(f"Generated cache is invalid: SHA-256 mismatch for {font.get('file')}")
    return manifest


def publish(cache_root: Path, manifest: dict, files: dict[str, bytes]) -> str:
    cache_root.mkdir(parents=True, exist_ok=True)
    final = Path(os.path.abspath(cache_root / CACHE_NAME))
    if final.is_dir():
        return str(final)
    staging = cache_root / f".{CACHE_NAME}.{os.getpid()}.{uuid.uuid4().hex}"
    staging.mkdir()
    try:
        for name, _text in SUBSETS:
            (staging / f"{name}.ttf").write_bytes(files[name])
        (staging / "manifest.json").write_text(dump_manifest(manifest), encoding="ascii")
        try:
            os.rename(staging, final)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
            if not final.is_dir():
                raise
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return str(final)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args(argv)
    subset = require_fonttools()
    source = args.source if args.source is not None else default_source()
    read_source(source)
    cache_root = Path(args.cache_root)
    final = Path(os.path.abspath(cache_root / CACHE_NAME))
    if final.is_dir():
        manifest = verify(final)
        directory = str(final)
    else:
        built = {name: subset_font(subset, source, text) for name, text in SUBSETS}
        for name, blob in built.items():
            if len(blob) > 65_536:
                fail(f"Generated font fixture is oversized: {name}")
        manifest = manifest_for(built)
        directory = publish(cache_root, manifest, built)
        manifest = verify(Path(directory))
    sys.stdout.write(json.dumps({"directory": directory, "manifest": manifest}, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
