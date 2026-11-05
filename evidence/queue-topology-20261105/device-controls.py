"""Replace only the new build-time switch in an isolated source copy for interleaved draws; A keeps the previous two-attachment path."""
from pathlib import Path
import sys
root=Path.cwd();gpu=Path('frontend/design-client/src/kernel/gpu');copy=Path(sys.argv[1])/gpu
p=copy/'renderer.ts';src=(root/gpu/'renderer.ts').read_text()
flag="import.meta.env.VITE_DESIGN_SPARSE_SOURCE_WORK!=='0'"
assert src.count(flag)==2
dense="import.meta.env.VITE_DESIGN_DENSE_SPARSE_BATCH==='1'"
assert src.count(dense)==1
src=src.replace(dense, "false" if 'default' in sys.argv[2:] else "(globalThis as any).__qaQueueArm !== 'A'")
p.write_text(src.replace(flag,"(globalThis as any).__qaQueueArm !== 'A'"))
(copy/'qa-diag.ts').write_text("export {setGpuDiagnosticSink} from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'\n")
