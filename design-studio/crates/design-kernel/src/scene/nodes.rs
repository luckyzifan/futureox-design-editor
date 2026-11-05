//! Importers build ordinary ordered maps. An installed editable scene can freeze
//! its keys once; snapshots then share that index and a persistent vector of
//! immutable node payloads. A property change replaces a slot, never the index.
use super::Node;
use either::Either;
use im::Vector;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::{BTreeMap, btree_map},
    fmt,
    ops::Index,
    sync::Arc,
};

#[derive(Clone)]
pub struct DocumentNodes(Storage);

#[derive(Clone)]
enum Storage {
    Owned(BTreeMap<String, Node>),
    Shared {
        index: Arc<BTreeMap<String, usize>>,
        slots: Vector<Arc<Node>>,
    },
}

impl DocumentNodes {
    pub(crate) fn share(&mut self) {
        let Storage::Owned(nodes) = &mut self.0 else {
            return;
        };
        let mut slots = Vector::new();
        let index = std::mem::take(nodes)
            .into_iter()
            .map(|(key, node)| {
                let slot = slots.len();
                slots.push_back(Arc::new(node));
                (key, slot)
            })
            .collect();
        self.0 = Storage::Shared {
            index: Arc::new(index),
            slots,
        };
    }

    pub fn into_map(self) -> BTreeMap<String, Node> {
        match self.0 {
            Storage::Owned(nodes) => nodes,
            Storage::Shared { index, slots } => {
                let values = slots.into_iter().map(Arc::unwrap_or_clone);
                match Arc::try_unwrap(index) {
                    Ok(keys) => keys.into_keys().zip(values).collect(),
                    Err(keys) => keys.keys().cloned().zip(values).collect(),
                }
            }
        }
    }

    // Structural edits still use the ordinary map; a successful installation
    // freezes the new topology. Do not keep removed keys or old node payloads.
    fn structural(&mut self) -> &mut BTreeMap<String, Node> {
        if !matches!(self.0, Storage::Owned(_)) {
            self.0 = Storage::Owned(std::mem::take(self).into_map());
        }
        let Storage::Owned(map) = &mut self.0 else {
            unreachable!()
        };
        map
    }

    pub fn len(&self) -> usize {
        match &self.0 {
            Storage::Owned(map) => map.len(),
            Storage::Shared { slots, .. } => slots.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn keys(&self) -> impl DoubleEndedIterator<Item = &String> + ExactSizeIterator {
        match &self.0 {
            Storage::Owned(map) => Either::Left(map.keys()),
            Storage::Shared { index, .. } => Either::Right(index.keys()),
        }
    }
    pub fn values(&self) -> impl DoubleEndedIterator<Item = &Node> + ExactSizeIterator {
        match &self.0 {
            Storage::Owned(map) => Either::Left(map.values()),
            Storage::Shared { slots, .. } => Either::Right(slots.iter().map(Arc::as_ref)),
        }
    }
    pub fn into_values(self) -> impl DoubleEndedIterator<Item = Node> + ExactSizeIterator {
        match self.0 {
            Storage::Owned(map) => Either::Left(map.into_values()),
            Storage::Shared { slots, .. } => {
                Either::Right(slots.into_iter().map(Arc::unwrap_or_clone))
            }
        }
    }
    pub fn values_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut Node> + ExactSizeIterator {
        match &mut self.0 {
            Storage::Owned(map) => Either::Left(map.values_mut()),
            Storage::Shared { slots, .. } => Either::Right(slots.iter_mut().map(Arc::make_mut)),
        }
    }
    pub fn iter(&self) -> <&Self as IntoIterator>::IntoIter {
        self.into_iter()
    }
    pub fn get(&self, id: &str) -> Option<&Node> {
        match &self.0 {
            Storage::Owned(map) => map.get(id),
            Storage::Shared { index, slots } => Some(slots[*index.get(id)?].as_ref()),
        }
    }
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Node> {
        match &mut self.0 {
            Storage::Owned(map) => map.get_mut(id),
            Storage::Shared { index, slots } => Some(Arc::make_mut(&mut slots[*index.get(id)?])),
        }
    }
    pub fn contains_key(&self, id: &str) -> bool {
        match &self.0 {
            Storage::Owned(map) => map.contains_key(id),
            Storage::Shared { index, .. } => index.contains_key(id),
        }
    }
    pub fn insert(&mut self, id: String, node: Node) -> Option<Node> {
        if let Storage::Shared { index, slots } = &mut self.0
            && let Some(&slot) = index.get(&id)
        {
            return Some(Arc::unwrap_or_clone(std::mem::replace(
                &mut slots[slot],
                Arc::new(node),
            )));
        }
        self.structural().insert(id, node)
    }
    /// A patch already owns the prior snapshot. Never unwrap or clone the
    /// replaced payload just to return it to a caller that will discard it.
    pub(crate) fn set(&mut self, id: &str, node: Node) {
        if let Storage::Shared { index, slots } = &mut self.0
            && let Some(&slot) = index.get(id)
        {
            slots[slot] = Arc::new(node);
            return;
        }
        self.structural().insert(id.to_owned(), node);
    }
    pub fn remove(&mut self, id: &str) -> Option<Node> {
        if !self.contains_key(id) {
            return None;
        }
        self.structural().remove(id)
    }
    pub fn retain(&mut self, f: impl FnMut(&String, &mut Node) -> bool) {
        self.structural().retain(f);
    }
}

impl Default for DocumentNodes {
    fn default() -> Self {
        Self(Storage::Owned(BTreeMap::new()))
    }
}
impl From<BTreeMap<String, Node>> for DocumentNodes {
    fn from(nodes: BTreeMap<String, Node>) -> Self {
        Self(Storage::Owned(nodes))
    }
}
impl<const N: usize> From<[(String, Node); N]> for DocumentNodes {
    fn from(nodes: [(String, Node); N]) -> Self {
        Self::from(BTreeMap::from(nodes))
    }
}
impl FromIterator<(String, Node)> for DocumentNodes {
    fn from_iter<I: IntoIterator<Item = (String, Node)>>(iter: I) -> Self {
        Self::from(iter.into_iter().collect::<BTreeMap<_, _>>())
    }
}
impl Extend<(String, Node)> for DocumentNodes {
    fn extend<I: IntoIterator<Item = (String, Node)>>(&mut self, iter: I) {
        for (id, node) in iter {
            self.insert(id, node);
        }
    }
}
impl Index<&str> for DocumentNodes {
    type Output = Node;
    fn index(&self, id: &str) -> &Node {
        self.get(id).expect("no entry found for key")
    }
}
impl IntoIterator for DocumentNodes {
    type Item = (String, Node);
    type IntoIter = btree_map::IntoIter<String, Node>;
    fn into_iter(self) -> Self::IntoIter {
        self.into_map().into_iter()
    }
}
impl<'a> IntoIterator for &'a DocumentNodes {
    type Item = (&'a String, &'a Node);
    type IntoIter = Either<
        btree_map::Iter<'a, String, Node>,
        std::iter::Zip<
            btree_map::Keys<'a, String, usize>,
            std::iter::Map<im::vector::Iter<'a, Arc<Node>>, fn(&'a Arc<Node>) -> &'a Node>,
        >,
    >;
    fn into_iter(self) -> Self::IntoIter {
        match &self.0 {
            Storage::Owned(map) => Either::Left(map.iter()),
            Storage::Shared { index, slots } => Either::Right(
                index
                    .keys()
                    .zip(slots.iter().map(Arc::as_ref as fn(&Arc<Node>) -> &Node)),
            ),
        }
    }
}
impl<'a> IntoIterator for &'a mut DocumentNodes {
    type Item = (&'a String, &'a mut Node);
    type IntoIter = Either<
        btree_map::IterMut<'a, String, Node>,
        std::iter::Zip<
            btree_map::Keys<'a, String, usize>,
            std::iter::Map<
                im::vector::IterMut<'a, Arc<Node>>,
                fn(&'a mut Arc<Node>) -> &'a mut Node,
            >,
        >,
    >;
    fn into_iter(self) -> Self::IntoIter {
        match &mut self.0 {
            Storage::Owned(map) => Either::Left(map.iter_mut()),
            Storage::Shared { index, slots } => Either::Right(
                index.keys().zip(
                    slots
                        .iter_mut()
                        .map(Arc::make_mut as fn(&mut Arc<Node>) -> &mut Node),
                ),
            ),
        }
    }
}
impl PartialEq for DocumentNodes {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().eq(other.iter())
    }
}
impl fmt::Debug for DocumentNodes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self).finish()
    }
}
impl Serialize for DocumentNodes {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self)
    }
}
impl<'de> Deserialize<'de> for DocumentNodes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        BTreeMap::deserialize(d).map(Self::from)
    }
}
