//! Exact serde data without JSON text parsing. Geometry retains separate f32 words.
//! Tags: end/null/bool/f64/string/new-string/array/map. Strings are interned per record.
use serde::ser::{self, Serialize, SerializeMap, SerializeSeq, SerializeStruct, SerializeStructVariant, SerializeTuple, SerializeTupleStruct, SerializeTupleVariant};
use std::collections::HashMap;
#[derive(Debug)] pub struct Error(String);
impl std::fmt::Display for Error {fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str(&self.0)}}
impl std::error::Error for Error {}
impl ser::Error for Error {fn custom<T:std::fmt::Display>(message:T)->Self{Self(message.to_string())}}
pub fn encode<T:Serialize+?Sized>(value:&T)->Result<Vec<u8>,String>{
    let mut writer=Writer{bytes:Vec::new(),strings:HashMap::new(),zero_offsets:false};
    value.serialize(&mut writer).map_err(|e|e.to_string())?;Ok(writer.bytes)
}
/// Compiled GpuPath/AreaPath addresses are relocatable. Keep all other
/// authored/compiler fields exact without building an intermediate JSON tree.
pub fn encode_source<T:Serialize+?Sized>(value:&T)->Result<Vec<u8>,String>{
    let mut writer=Writer{bytes:Vec::new(),strings:HashMap::new(),zero_offsets:true};
    value.serialize(&mut writer).map_err(|e|e.to_string())?;Ok(writer.bytes)
}
struct Writer {bytes:Vec<u8>,strings:HashMap<String,u32>,zero_offsets:bool}
impl Writer {
    fn number(&mut self,n:f64){if !n.is_finite(){self.bytes.push(1)}else{self.bytes.push(4);self.bytes.extend(n.to_le_bytes())}}
    fn text(&mut self,value:&str)->Result<(),Error>{
        if let Some(index)=self.strings.get(value){self.bytes.push(5);self.bytes.extend(index.to_le_bytes());return Ok(())}
        let length=u32::try_from(value.len()).map_err(ser::Error::custom)?;
        let index=u32::try_from(self.strings.len()).map_err(ser::Error::custom)?;
        self.bytes.push(6);self.bytes.extend(length.to_le_bytes());self.bytes.extend(value.as_bytes());self.strings.insert(value.to_owned(),index);Ok(())
    }
}
struct Compound<'a>{writer:&'a mut Writer,extra:bool}
macro_rules! number {($name:ident,$ty:ty)=>{fn $name(self,value:$ty)->Result<(),Error>{self.number(value as f64);Ok(())}}}
impl<'a> ser::Serializer for &'a mut Writer {
    type Ok=();type Error=Error;type SerializeSeq=Compound<'a>;type SerializeTuple=Compound<'a>;type SerializeTupleStruct=Compound<'a>;
    type SerializeTupleVariant=Compound<'a>;type SerializeMap=Compound<'a>;type SerializeStruct=Compound<'a>;type SerializeStructVariant=Compound<'a>;
    fn serialize_bool(self,v:bool)->Result<(),Error>{self.bytes.push(if v{3}else{2});Ok(())}
    number!(serialize_i8,i8);number!(serialize_i16,i16);number!(serialize_i32,i32);number!(serialize_i64,i64);number!(serialize_i128,i128);
    number!(serialize_u8,u8);number!(serialize_u16,u16);number!(serialize_u32,u32);number!(serialize_u64,u64);number!(serialize_u128,u128);
    fn serialize_f32(self,v:f32)->Result<(),Error>{
        // Preserve the old serde_json f32 spelling's binary64 interpretation.
        // GPU program words never enter this path and remain bit-for-bit f32.
        let n=if v.is_finite(){serde_json::to_string(&v).map_err(ser::Error::custom)?.parse::<f64>().map_err(ser::Error::custom)?}else{f64::NAN};
        self.number(n);Ok(())
    }
    fn serialize_f64(self,v:f64)->Result<(),Error>{self.number(v);Ok(())}
    fn serialize_char(self,v:char)->Result<(),Error>{self.text(&v.to_string())}
    fn serialize_str(self,v:&str)->Result<(),Error>{self.text(v)}
    fn serialize_bytes(self,v:&[u8])->Result<(),Error>{self.bytes.push(7);for b in v{self.number(f64::from(*b))}self.bytes.push(0);Ok(())}
    fn serialize_none(self)->Result<(),Error>{self.bytes.push(1);Ok(())}
    fn serialize_some<T:Serialize+?Sized>(self,v:&T)->Result<(),Error>{v.serialize(self)}
    fn serialize_unit(self)->Result<(),Error>{self.serialize_none()}
    fn serialize_unit_struct(self,_:&'static str)->Result<(),Error>{self.serialize_none()}
    fn serialize_unit_variant(self,_:&'static str,_:u32,v:&'static str)->Result<(),Error>{self.text(v)}
    fn serialize_newtype_struct<T:Serialize+?Sized>(self,_:&'static str,v:&T)->Result<(),Error>{v.serialize(self)}
    fn serialize_newtype_variant<T:Serialize+?Sized>(self,_:&'static str,_:u32,k:&'static str,v:&T)->Result<(),Error>{self.bytes.push(8);self.text(k)?;v.serialize(&mut *self)?;self.bytes.push(0);Ok(())}
    fn serialize_seq(self,_:Option<usize>)->Result<Compound<'a>,Error>{self.bytes.push(7);Ok(Compound{writer:self,extra:false})}
    fn serialize_tuple(self,_:usize)->Result<Compound<'a>,Error>{self.serialize_seq(None)}
    fn serialize_tuple_struct(self,_:&'static str,_:usize)->Result<Compound<'a>,Error>{self.serialize_seq(None)}
    fn serialize_tuple_variant(self,_:&'static str,_:u32,k:&'static str,_:usize)->Result<Compound<'a>,Error>{self.bytes.push(8);self.text(k)?;self.bytes.push(7);Ok(Compound{writer:self,extra:true})}
    fn serialize_map(self,_:Option<usize>)->Result<Compound<'a>,Error>{self.bytes.push(8);Ok(Compound{writer:self,extra:false})}
    fn serialize_struct(self,_:&'static str,_:usize)->Result<Compound<'a>,Error>{self.serialize_map(None)}
    fn serialize_struct_variant(self,_:&'static str,_:u32,k:&'static str,_:usize)->Result<Compound<'a>,Error>{self.bytes.push(8);self.text(k)?;self.bytes.push(8);Ok(Compound{writer:self,extra:true})}
    fn is_human_readable(&self)->bool{true}
}
impl Compound<'_>{fn finish(self)->Result<(),Error>{self.writer.bytes.push(0);if self.extra{self.writer.bytes.push(0)}Ok(())}}
macro_rules! sequence {($trait:ident,$field:ident)=>{impl $trait for Compound<'_>{type Ok=();type Error=Error;
    fn $field<T:Serialize+?Sized>(&mut self,v:&T)->Result<(),Error>{v.serialize(&mut *self.writer)}fn end(self)->Result<(),Error>{self.finish()}}}}
sequence!(SerializeSeq,serialize_element);sequence!(SerializeTuple,serialize_element);sequence!(SerializeTupleStruct,serialize_field);sequence!(SerializeTupleVariant,serialize_field);
impl SerializeMap for Compound<'_>{type Ok=();type Error=Error;
    fn serialize_key<T:Serialize+?Sized>(&mut self,k:&T)->Result<(),Error>{
        match serde_json::to_value(k).map_err(ser::Error::custom)? {
            serde_json::Value::String(s)=>self.writer.text(&s),serde_json::Value::Number(n)=>self.writer.text(&n.to_string()),
            _=>Err(ser::Error::custom("Non-string frame map key")),
        }
    }
    fn serialize_value<T:Serialize+?Sized>(&mut self,v:&T)->Result<(),Error>{v.serialize(&mut *self.writer)}
    fn end(self)->Result<(),Error>{self.finish()}
}
macro_rules! structure {($trait:ident)=>{impl $trait for Compound<'_>{type Ok=();type Error=Error;
    fn serialize_field<T:Serialize+?Sized>(&mut self,k:&'static str,v:&T)->Result<(),Error>{self.writer.text(k)?;if self.writer.zero_offsets&&k=="first"{self.writer.number(0.);Ok(())}else{v.serialize(&mut *self.writer)}}
    fn end(self)->Result<(),Error>{self.finish()}}}}
structure!(SerializeStruct);structure!(SerializeStructVariant);
