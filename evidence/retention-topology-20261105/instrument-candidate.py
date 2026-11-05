"""Install the preceding CPU experiment's timers in a disposable B source copy.
Usage: python3 instrument-candidate.py FROZEN_INSTRUMENTED_B_COPY CURRENT_WORKTREE
"""
from pathlib import Path
import sys

dest, working = [Path(arg).resolve() for arg in sys.argv[1:3]]
assert dest != working and not (dest/'.git').exists()
folder = Path('design-studio/crates/design-kernel/src')
assert (dest/folder/'cpu_ab_probe.rs').is_file()
renderer = (working/folder/'renderer.rs').read_text()
at = renderer.index('        let density = if options.raster_profile.is_export() { 2 } else { 1 };', renderer.index('    fn linear_rect_pixels('))
renderer = renderer[:at]+'        crate::cpu_ab_probe::begin();\n'+renderer[at:]
marker = '        let mut target = Surface::new_in(target_rect, &budget)?;'
assert renderer.count(marker)==1
(dest/folder/'renderer.rs').write_text(renderer.replace(marker, '        crate::cpu_ab_probe::end();\n'+marker))
plan = (working/folder/'cpu_frame_plan.rs').read_text()
for marker, call in [('// Frame analysis begins.','plan'), ('// Reuse exactly the same leaf result.','hit')]:
    assert plan.count(marker)==1
    plan = plan.replace(marker, f'crate::cpu_ab_probe::{call}();')
(dest/folder/'cpu_frame_plan.rs').write_text(plan)
