//! Font-unit outlines shared across nodes, positions and zooms. Store owned
//! f32 commands, never font faces borrowing their own backing allocation.
use std::sync::Arc;
use crate::read_cache::ReadCache;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    pub font: [u8; 32],
    pub face: u32,
    pub glyph: u16,
    pub weight: u32,
    pub axes: Vec<([u8; 4], u32)>,
}
#[derive(Clone, Copy)]
pub(crate) enum Command {
    Move(f32, f32), Line(f32, f32), Quad(f32, f32, f32, f32),
    Cubic(f32, f32, f32, f32, f32, f32), Close,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(glyph:u16)->Key { Key{font:[0;32],face:0,glyph,weight:400f32.to_bits(),axes:vec![]} }
    #[test]
    fn entries_are_bounded_and_hits_refresh_residency() {
        let mut cache=Cache::default();
        for id in 0..4096 { cache.insert(key(id),Outline::default()); }
        assert!(cache.get(&key(0)).is_some());
        cache.insert(key(4096),Outline::default());
        assert!(cache.get(&key(0)).is_some());
        assert!(cache.get(&key(1)).is_none());
        assert_eq!(cache.inner.stats()["entries"].as_u64().unwrap(),4096);
        assert!(cache.inner.stats()["bytes"].as_u64().unwrap()<=Cache::LIMIT as u64);
    }
}
#[derive(Default)]
pub(crate) struct Outline {
    pub commands: Vec<Command>,
    pub units_per_em: i32,
    pub weight_axis: bool,
}
impl Outline {
    pub fn replay(&self, builder: &mut impl ttf_parser::OutlineBuilder) {
        for command in &self.commands {
            match *command {
                Command::Move(x,y) => builder.move_to(x,y),
                Command::Line(x,y) => builder.line_to(x,y),
                Command::Quad(a,b,x,y) => builder.quad_to(a,b,x,y),
                Command::Cubic(a,b,c,d,x,y) => builder.curve_to(a,b,c,d,x,y),
                Command::Close => builder.close(),
            }
        }
    }
}
impl ttf_parser::OutlineBuilder for Outline {
    fn move_to(&mut self,x:f32,y:f32) { self.commands.push(Command::Move(x,y)); }
    fn line_to(&mut self,x:f32,y:f32) { self.commands.push(Command::Line(x,y)); }
    fn quad_to(&mut self,a:f32,b:f32,x:f32,y:f32) { self.commands.push(Command::Quad(a,b,x,y)); }
    fn curve_to(&mut self,a:f32,b:f32,c:f32,d:f32,x:f32,y:f32) { self.commands.push(Command::Cubic(a,b,c,d,x,y)); }
    fn close(&mut self) { self.commands.push(Command::Close); }
}
pub(crate) struct Cache { inner: ReadCache<Key, Outline>, builds: u64 }
impl Default for Cache {
    fn default() -> Self { Self { inner: ReadCache::new(Self::LIMIT, 4096), builds: 0 } }
}
impl Cache {
    const LIMIT: usize = 16 * 1024 * 1024;
    pub fn get(&self, key: &Key) -> Option<Arc<Outline>> { self.inner.get(key) }
    pub fn insert(&mut self, key: Key, outline: Outline) -> Arc<Outline> {
        self.builds += 1;
        let bytes = outline.commands.capacity() * std::mem::size_of::<Command>()
            + 2 * key.axes.capacity() * std::mem::size_of::<([u8;4],u32)>() + 256;
        self.inner.insert(key, outline, bytes)
    }
    pub fn stats(&self) -> serde_json::Value {
        let mut stats = self.inner.stats(); stats["builds"] = self.builds.into(); stats
    }
}
