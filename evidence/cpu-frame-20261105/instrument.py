"""Install matching CPU-wall probes in a disposable kernel copy, before building."""
from pathlib import Path
import shutil, sys

root = Path(sys.argv[1]).resolve()
src = root/'design-studio/crates/design-kernel/src'
assert not (root/'.git').exists(), 'use a disposable source copy'
f = src/'renderer.rs'
s = f.read_text()
def insert(marker, before):
    global s
    assert s.count(marker) == 1, marker
    s = s.replace(marker, before + marker)

# First and last boundaries are identical across arms. The multi-tile builder
# runs between them on the first planned tile. No per-node clock reads.
marker = '        let density = if options.raster_profile.is_export() { 2 } else { 1 };'
start = s.index('    fn linear_rect_pixels(')
location = s.index(marker, start)
s = s[:location] + '        crate::cpu_ab_probe::begin();\n' + s[location:]
insert('        let mut target = Surface::new_in(extent, &budget)?;', '        crate::cpu_ab_probe::end();\n')
f.write_text(s)
plan = src/'cpu_frame_plan.rs'
if plan.exists():
    p = plan.read_text()
    for marker, probe in [('// Frame analysis begins.', 'plan'), ('// Reuse exactly the same leaf result.', 'hit')]:
        assert p.count(marker)==1, marker
        p = p.replace(marker, f'crate::cpu_ab_probe::{probe}();')
    plan.write_text(p)
lib = src/'lib.rs'
with lib.open('a') as out: out.write('\npub mod cpu_ab_probe;\n')
(src/'cpu_ab_probe.rs').write_text('''
use std::{cell::Cell,time::Instant};
thread_local! {
    static START: Cell<Option<Instant>> = const { Cell::new(None) };
    static NS: Cell<u128> = const { Cell::new(0) };
    static TILES: Cell<u64> = const { Cell::new(0) };
    static PLANS: Cell<u64> = const { Cell::new(0) };
    static HITS: Cell<u64> = const { Cell::new(0) };
}
pub fn reset(){NS.set(0);TILES.set(0);PLANS.set(0);HITS.set(0);START.set(None)}
pub fn begin(){START.set(Some(Instant::now()));}
pub fn end(){if let Some(t)=START.take(){NS.set(NS.get()+t.elapsed().as_nanos());TILES.set(TILES.get()+1);}}
pub fn plan(){PLANS.set(PLANS.get()+1);}
pub fn hit(){HITS.set(HITS.get()+1);}
pub fn read()->(f64,u64,u64,u64){(NS.get() as f64/1e6,TILES.get(),PLANS.get(),HITS.get())}
''')
shutil.copy(Path(__file__).with_name('probe.rs'),src.parent/'examples/cpu_frame_probe.rs')
