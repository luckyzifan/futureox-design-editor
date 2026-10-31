//! Keep Node's serializer authoritative while packed geometry is stored beside
//! it. Only the top-level vectorGeometry field is omitted; nested authored data
//! and every other field retain their original serialization and ordering.
use crate::scene::Node;
use serde::{Serialize, Serializer, ser::SerializeStruct};

pub(super) fn without_geometry<S: Serializer>(node: &Node, inner: S) -> Result<S::Ok, S::Error> {
    node.serialize(WithoutGeometry { inner, present: node.vector_geometry.is_some() })
}
struct WithoutGeometry<S> { inner: S, present: bool }
struct Fields<S>(S);
impl<S: SerializeStruct> SerializeStruct for Fields<S> {
    type Ok = S::Ok;
    type Error = S::Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), S::Error> {
        if key == "vectorGeometry" { self.0.skip_field(key) } else { self.0.serialize_field(key, value) }
    }
    fn skip_field(&mut self, key: &'static str) -> Result<(), S::Error> { self.0.skip_field(key) }
    fn end(self) -> Result<S::Ok, S::Error> { self.0.end() }
}
macro_rules! scalar {
    ($($method:ident($value:ty)),* $(,)?) => {
        $(fn $method(self, value: $value) -> Result<Self::Ok, Self::Error> { self.inner.$method(value) })*
    };
}
impl<S: Serializer> Serializer for WithoutGeometry<S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = S::SerializeSeq;
    type SerializeTuple = S::SerializeTuple;
    type SerializeTupleStruct = S::SerializeTupleStruct;
    type SerializeTupleVariant = S::SerializeTupleVariant;
    type SerializeMap = S::SerializeMap;
    type SerializeStruct = Fields<S::SerializeStruct>;
    type SerializeStructVariant = S::SerializeStructVariant;
    scalar!(serialize_bool(bool), serialize_i8(i8), serialize_i16(i16), serialize_i32(i32), serialize_i64(i64), serialize_i128(i128),
        serialize_u8(u8), serialize_u16(u16), serialize_u32(u32), serialize_u64(u64), serialize_u128(u128),
        serialize_f32(f32), serialize_f64(f64), serialize_char(char), serialize_str(&str), serialize_bytes(&[u8]));
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> { self.inner.serialize_none() }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<Self::Ok, Self::Error> { self.inner.serialize_some(value) }
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> { self.inner.serialize_unit() }
    fn serialize_unit_struct(self, name: &'static str) -> Result<Self::Ok, Self::Error> { self.inner.serialize_unit_struct(name) }
    fn serialize_unit_variant(self, name: &'static str, index: u32, variant: &'static str) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_unit_variant(name, index, variant)
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, name: &'static str, value: &T) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_newtype_struct(name, value)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(self, name: &'static str, index: u32, variant: &'static str, value: &T) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_newtype_variant(name, index, variant, value)
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> { self.inner.serialize_seq(len) }
    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> { self.inner.serialize_tuple(len) }
    fn serialize_tuple_struct(self, name: &'static str, len: usize) -> Result<Self::SerializeTupleStruct, Self::Error> { self.inner.serialize_tuple_struct(name, len) }
    fn serialize_tuple_variant(self, name: &'static str, index: u32, variant: &'static str, len: usize) -> Result<Self::SerializeTupleVariant, Self::Error> {
        self.inner.serialize_tuple_variant(name, index, variant, len)
    }
    fn serialize_map(self, len: Option<usize>) -> Result<Self::SerializeMap, Self::Error> { self.inner.serialize_map(len) }
    fn serialize_struct(self, name: &'static str, len: usize) -> Result<Self::SerializeStruct, Self::Error> {
        Ok(Fields(self.inner.serialize_struct(name, len - usize::from(self.present))?))
    }
    fn serialize_struct_variant(self, name: &'static str, index: u32, variant: &'static str, len: usize) -> Result<Self::SerializeStructVariant, Self::Error> {
        self.inner.serialize_struct_variant(name, index, variant, len)
    }
    fn is_human_readable(&self) -> bool { self.inner.is_human_readable() }
}
