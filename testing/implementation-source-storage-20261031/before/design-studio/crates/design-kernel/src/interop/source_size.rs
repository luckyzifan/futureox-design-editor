//! Conservative JSON size admission without formatting every floating value.
//! If this bound is too large, the caller retains the original exact counter.
use serde::{Serialize,Serializer,ser::{Impossible,SerializeStruct}};
use serde_json::Value;
type E=serde_json::Error;
fn unsupported()->E{<E as serde::ser::Error>::custom("Unknown numeric serialization")}
struct NumberBound(usize);
fn string_size(value:&str)->Option<usize>{
 let mut bytes=value.len().checked_add(2)?;
 for byte in value.bytes(){
  let extra=match byte {b'"'|b'\\'|b'\x08'|b'\x0c'|b'\n'|b'\r'|b'\t'=>1,0..=31=>5,_=>0};
  bytes=bytes.checked_add(extra)?;
 }
 Some(bytes)
}
macro_rules! number {($name:ident,$ty:ty,$size:expr)=>{fn $name(self,_v:$ty)->Result<usize,E>{Ok($size)}}}
impl Serializer for NumberBound {
 type Ok=usize;type Error=E;
 type SerializeSeq=Impossible<usize,E>;type SerializeTuple=Impossible<usize,E>;type SerializeTupleStruct=Impossible<usize,E>;
 type SerializeTupleVariant=Impossible<usize,E>;type SerializeMap=Impossible<usize,E>;type SerializeStruct=Self;type SerializeStructVariant=Impossible<usize,E>;
 number!(serialize_i8,i8,4);number!(serialize_u8,u8,3);number!(serialize_i16,i16,6);number!(serialize_u16,u16,5);
 number!(serialize_i32,i32,11);number!(serialize_u32,u32,10);number!(serialize_i64,i64,20);number!(serialize_u64,u64,20);
 number!(serialize_i128,i128,40);number!(serialize_u128,u128,39);number!(serialize_f32,f32,32);number!(serialize_f64,f64,32);
 fn serialize_str(self,v:&str)->Result<usize,E>{string_size(v).ok_or_else(unsupported)}
 fn serialize_bool(self,_v:bool)->Result<usize,E>{Err(unsupported())}
 fn serialize_char(self,_v:char)->Result<usize,E>{Err(unsupported())}
 fn serialize_bytes(self,_v:&[u8])->Result<usize,E>{Err(unsupported())}
 fn serialize_none(self)->Result<usize,E>{Ok(4)}
 fn serialize_some<T:Serialize+?Sized>(self,v:&T)->Result<usize,E>{v.serialize(self)}
 fn serialize_unit(self)->Result<usize,E>{Ok(4)}
 fn serialize_unit_struct(self,_n:&'static str)->Result<usize,E>{Ok(4)}
 fn serialize_unit_variant(self,_n:&'static str,_i:u32,_v:&'static str)->Result<usize,E>{Err(unsupported())}
 fn serialize_newtype_struct<T:Serialize+?Sized>(self,_n:&'static str,v:&T)->Result<usize,E>{v.serialize(self)}
 fn serialize_newtype_variant<T:Serialize+?Sized>(self,_n:&'static str,_i:u32,_v:&'static str,_value:&T)->Result<usize,E>{Err(unsupported())}
 fn serialize_seq(self,_n:Option<usize>)->Result<Self::SerializeSeq,E>{Err(unsupported())}
 fn serialize_tuple(self,_n:usize)->Result<Self::SerializeTuple,E>{Err(unsupported())}
 fn serialize_tuple_struct(self,_name:&'static str,_n:usize)->Result<Self::SerializeTupleStruct,E>{Err(unsupported())}
 fn serialize_tuple_variant(self,_name:&'static str,_i:u32,_v:&'static str,_n:usize)->Result<Self::SerializeTupleVariant,E>{Err(unsupported())}
 fn serialize_map(self,_n:Option<usize>)->Result<Self::SerializeMap,E>{Err(unsupported())}
 // serde_json's arbitrary-precision Number, if enabled by a future build,
 // serializes a private struct containing its raw string. Counting that
 // wrapper only overestimates the unquoted number; no 32-byte assumption.
 fn serialize_struct(self,_name:&'static str,_n:usize)->Result<Self,E>{Ok(Self(2))}
 fn serialize_struct_variant(self,_name:&'static str,_i:u32,_v:&'static str,_n:usize)->Result<Self::SerializeStructVariant,E>{Err(unsupported())}
}
impl SerializeStruct for NumberBound {
 type Ok=usize;type Error=E;
 fn serialize_field<T:Serialize+?Sized>(&mut self,key:&'static str,value:&T)->Result<(),E>{
  self.0=self.0.checked_add(string_size(key).and_then(|n|n.checked_add(2)).ok_or_else(unsupported)?)
   .and_then(|n|value.serialize(NumberBound(0)).ok().and_then(|v|n.checked_add(v))).ok_or_else(unsupported)?;Ok(())
 }
 fn end(self)->Result<usize,E>{Ok(self.0)}
}
pub(super) fn upper_bound(value:&Value,limit:usize)->Option<usize>{
 let size=match value {
  Value::Null=>4,Value::Bool(v)=>if *v{4}else{5},
  Value::Number(n)=>n.serialize(NumberBound(0)).ok()?,
  Value::String(s)=>string_size(s)?,
  Value::Array(items)=>{
   let mut size=2usize;
   for item in items{size=size.checked_add(upper_bound(item,limit)?)?.checked_add(1)?;if size>limit{return None}}
   size
  },
  Value::Object(items)=>{
   let mut size=2usize;
   for (key,value) in items{size=size.checked_add(string_size(key)?.checked_add(2)?)?.checked_add(upper_bound(value,limit)?)?;if size>limit{return None}}
   size
  },
 };
 (size<=limit).then_some(size)
}

#[cfg(test)]mod tests {
 use super::*;
 #[test]fn escaped_strings_match_json_without_sixfold_overestimation(){
  let text:String=(0u8..=127).map(char::from).chain("雪🖌".chars()).collect();
  for text in [text,"a".repeat(1_000_000),"\u{0000}".repeat(1024)]{
   assert_eq!(string_size(&text).unwrap(),serde_json::to_vec(&text).unwrap().len());
  }
 }
 #[test]fn bound_covers_float_bits_unicode_controls_and_composition(){
  let mut state=0x934ce2301u64;
  for i in 0..10_000{
   state=state.wrapping_mul(6364136223846793005).wrapping_add(1);
   let value=f64::from_bits(state);if !value.is_finite(){continue}
   let v=serde_json::json!({"雪\n\"\\":[value,-0.0,i,u64::MAX,i64::MIN,"🖌\u{0000}\t\r"]});
   let actual=serde_json::to_vec(&v).unwrap().len();let bound=upper_bound(&v,usize::MAX).unwrap();
   assert!(bound>=actual);assert!(upper_bound(&v,bound-1).is_none());assert_eq!(upper_bound(&v,bound),Some(bound));
  }
 }
 #[test]fn an_overestimate_never_grants_extra_capacity(){
  let value=serde_json::json!([0,0,0,0]);let actual=serde_json::to_vec(&value).unwrap().len();
  assert!(upper_bound(&value,actual).is_none()); // caller must use its old exact counter
 }
}
