//! Generational handle arena shared by the graph, tile and snapshot APIs.
//!
//! Handles stay plain `u32` values across the wasm boundary so the JS side can
//! hold them cheaply; stale handles are rejected instead of aliasing freed
//! slots. Layout: index in the low 24 bits, generation in the high 8 bits.
use std::fmt;

pub const INVALID: u32 = 0;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Handle(u32);

impl Handle {
    pub const fn from_raw(raw: u32) -> Self {
        Handle(raw)
    }
    pub const fn raw(self) -> u32 {
        self.0
    }
    pub const fn is_valid(self) -> bool {
        self.0 != INVALID
    }
}

impl fmt::Debug for Handle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_valid() {
            write!(f, "Handle({}, gen {})", self.0 & 0xff_ff_ff, self.0 >> 24)
        } else {
            write!(f, "Handle(INVALID)")
        }
    }
}

#[derive(Clone)]
struct Slot<T> {
    generation: u8,
    live: bool,
    value: Option<T>,
}

/// Arena handing out generational handles; frees bump the generation so a
/// recycled index never validates an old handle.
pub struct Arena<T> {
    slots: Vec<Slot<T>>,
    free: Vec<u32>,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Arena {
            slots: Vec::new(),
            free: Vec::new(),
        }
    }
}

impl<T> Arena<T> {
    pub fn alloc(&mut self, value: T) -> Handle {
        let index = match self.free.pop() {
            Some(index) => {
                let slot = &mut self.slots[index as usize];
                slot.live = true;
                slot.value = Some(value);
                slot.generation += 1;
                (index & 0xff_ff_ff) | ((slot.generation as u32) << 24)
            }
            None => {
                let index = self.slots.len() as u32;
                debug_assert!(index < 0x80_00_00, "handle index space exhausted");
                self.slots.push(Slot {
                    generation: 1,
                    live: true,
                    value: Some(value),
                });
                index | (1 << 24)
            }
        };
        Handle::from_raw(index)
    }

    pub fn free(&mut self, handle: Handle) -> Option<T> {
        let (index, generation) = split(handle);
        let slot = self.slots.get_mut(index)?;
        if !slot.live || slot.generation != generation {
            return None;
        }
        slot.live = false;
        let value = slot.value.take();
        // Exhausted slots are retired; wrapping would resurrect stale handles.
        if slot.generation < u8::MAX {
            self.free.push(index as u32);
        }
        value
    }

    pub fn get(&self, handle: Handle) -> Option<&T> {
        let (index, generation) = split(handle);
        let slot = self.slots.get(index)?;
        if slot.live && slot.generation == generation {
            slot.value.as_ref()
        } else {
            None
        }
    }

    pub fn get_mut(&mut self, handle: Handle) -> Option<&mut T> {
        let (index, generation) = split(handle);
        let slot = self.slots.get_mut(index)?;
        if slot.live && slot.generation == generation {
            slot.value.as_mut()
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.slots.iter().filter(|slot| slot.live).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn handles(&self) -> impl Iterator<Item = Handle> + '_ {
        self.slots.iter().enumerate().filter_map(|(index, slot)| {
            (slot.live).then_some(Handle::from_raw(
                (index as u32 & 0xff_ff_ff) | ((slot.generation as u32) << 24),
            ))
        })
    }
}

fn split(handle: Handle) -> (usize, u8) {
    let raw = handle.raw();
    ((raw & 0xff_ff_ff) as usize, (raw >> 24) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_get_free() {
        let mut arena = Arena::default();
        let a = arena.alloc(10u32);
        let b = arena.alloc(20u32);
        assert_eq!(arena.get(a), Some(&10));
        assert_eq!(arena.get(b), Some(&20));
        assert_eq!(arena.free(a), Some(10));
        assert_eq!(arena.get(a), None);
        assert_eq!(arena.len(), 1);
    }

    #[test]
    fn stale_handles_rejected_after_recycle() {
        let mut arena = Arena::default();
        let a = arena.alloc(1u8);
        arena.free(a);
        let b = arena.alloc(2u8);
        assert_ne!(a, b, "recycled slot must carry a new generation");
        assert_eq!(arena.get(a), None, "old handle must not see the new value");
        assert_eq!(arena.get(b), Some(&2));
    }

    #[test]
    fn invalid_handle_is_falsy() {
        assert!(!Handle::from_raw(INVALID).is_valid());
        assert!(Handle::from_raw(INVALID | (1 << 24)).is_valid());
    }
    #[test]
    fn generations_never_wrap_back_to_a_stale_handle() {
        let mut arena = Arena::default();
        let first = arena.alloc(1);
        let mut current = first;
        for _ in 0..1000 {
            arena.free(current);
            current = arena.alloc(2);
            assert!(arena.get(first).is_none());
        }
    }
}
