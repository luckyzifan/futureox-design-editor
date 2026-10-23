"""Check the changed rational shader target without masking the full-generator failure."""
from pathlib import Path
import importlib.util

root = Path(__file__).resolve().parents[2]
source = root / "design-studio/scripts/generate-rational-glsl.py"
spec = importlib.util.spec_from_file_location("rational_generator", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.DEST.read_text() == module.generate(), "Rational GLSL drift"
print("Rational GLSL matches its WGSL source")
