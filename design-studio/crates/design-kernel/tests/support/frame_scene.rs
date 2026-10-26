//! Independent FGSC test reader. Never used to produce packets or GPU pixels.
use serde_json::{Map,Value};
use std::collections::BTreeMap;

fn word(bytes:&[u8],offset:usize)->usize{
    u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) as usize
}
fn value(bytes:&[u8])->Value{
    struct Reader<'a>{bytes:&'a[u8],at:usize,strings:Vec<String>}
    impl Reader<'_>{
        fn take(&mut self,n:usize)->&[u8]{let start=self.at;self.at+=n;assert!(self.at<=self.bytes.len());&self.bytes[start..self.at]}
        fn size(&mut self)->usize{u32::from_le_bytes(self.take(4).try_into().unwrap())as usize}
        fn value(&mut self)->Value{
            let tag=self.take(1)[0];
            match tag {
                1=>Value::Null,2=>Value::Bool(false),3=>Value::Bool(true),
                4=>Value::from(f64::from_le_bytes(self.take(8).try_into().unwrap())),
                5=>{let index=self.size();Value::String(self.strings[index].clone())},
                6=>{let n=self.size();let text=std::str::from_utf8(self.take(n)).unwrap().to_owned();self.strings.push(text.clone());Value::String(text)},
                7=>{let mut items=Vec::new();while self.bytes[self.at]!=0{items.push(self.value())}self.at+=1;Value::Array(items)},
                8=>{let mut fields=Map::new();while self.bytes[self.at]!=0{
                    let key=self.value().as_str().unwrap().to_owned();assert!(!fields.contains_key(&key));let item=self.value();fields.insert(key,item);
                }self.at+=1;Value::Object(fields)},
                _=>panic!("unknown FGSC metadata tag {tag}"),
            }
        }
    }
    let mut reader=Reader{bytes,at:0,strings:vec![]};let value=reader.value();assert_eq!(reader.at,bytes.len());value
}
pub fn geometry_words(packet:&[u8])->Vec<u32>{
    assert_eq!(&packet[..4],b"FGSC");assert_eq!(word(packet,4),1);
    let start=(24+word(packet,8)+3)&!3;let end=start+(word(packet,12)+word(packet,16))*4;
    assert_eq!(end+word(packet,20),packet.len());
    packet[start..end].chunks_exact(4).map(|word|u32::from_le_bytes(word.try_into().unwrap())).collect()
}
pub fn scope(packet:&[u8])->String{value(&packet[24..24+word(packet,8)])["resourceScope"].as_str().unwrap().to_owned()}
pub fn scene(packet:&[u8])->Value{
    geometry_words(packet);
    let mut metadata=value(&packet[24..24+word(packet,8)]);
    let mut at=((24+word(packet,8)+3)&!3)+(word(packet,12)+word(packet,16))*4;
    let mut resources=BTreeMap::new();
    while at<packet.len(){
        let id=word(packet,at);let kind=packet[at+4];let size=word(packet,at+5);at+=9;
        let data=&packet[at..at+size];at+=size;assert!(id>0&&!resources.contains_key(&id));
        let decoded=match kind{1=>Value::String(std::str::from_utf8(data).unwrap().into()),2|3=>value(data),_=>panic!("invalid public resource kind")};
        resources.insert(id,(kind,decoded));
    }
    fn images(item:&mut Value,resources:&BTreeMap<usize,(u8,Value)>){
        match item{
            Value::Array(items)=>for item in items{images(item,resources)},
            Value::Object(fields)=>{
                if let Some(Value::String(id))=fields.get("image"){
                    let resource=&resources[&id.parse::<usize>().unwrap()];assert_eq!(resource.0,1);fields.insert("image".into(),resource.1.clone());
                }
                for item in fields.values_mut(){images(item,resources)}
            },_=>{}
        }
    }
    let fields=metadata.as_object_mut().unwrap();
    let bindings=fields.remove("nodeResources").unwrap();let mut nodes=Map::new();
    for binding in bindings.as_array().unwrap(){
        let pair=binding.as_array().unwrap();assert_eq!(pair.len(),2);let name=pair[0].as_str().unwrap();
        let id=pair[1].as_f64().unwrap() as usize;let resource=&resources[&id];assert_eq!(resource.0,2);
        let mut node=resource.1["node"].clone();assert_eq!(node["id"].as_str(),Some(name));images(&mut node,&resources);
        assert!(nodes.insert(name.into(),node).is_none());
    }
    let plan=fields.remove("scenePlan").unwrap().as_f64().unwrap() as usize;assert_eq!(resources[&plan].0,3);
    let planned=resources[&plan].1["nodes"].as_array().unwrap();assert_eq!(planned.len(),nodes.len());
    for id in planned{assert!(nodes.contains_key(id.as_str().unwrap()))}
    assert!(fields.remove("resourceScope").unwrap().is_string());
    assert!(fields.remove("frameSequence").unwrap().as_f64().unwrap()>0.);
    assert!(fields["nodes"].as_object().unwrap().is_empty());fields.insert("nodes".into(),Value::Object(nodes));
    metadata
}
/// Wire numbers are JS binary64 values; preserve their bits, including -0,
/// without mistaking JSON's integer/float spelling for a semantic difference.
pub fn assert_fields(actual:&Value,expected:&Value){
    match(actual,expected){
        (Value::Number(a),Value::Number(b))=>assert_eq!(a.as_f64().unwrap().to_bits(),b.as_f64().unwrap().to_bits()),
        (Value::Array(a),Value::Array(b))=>{assert_eq!(a.len(),b.len());for(a,b)in a.iter().zip(b){assert_fields(a,b)}},
        (Value::Object(a),Value::Object(b))=>{assert_eq!(a.keys().collect::<Vec<_>>(),b.keys().collect::<Vec<_>>());for(key,a)in a{assert_fields(a,&b[key])}},
        _=>assert_eq!(actual,expected),
    }
}
pub fn assert_equivalent(a:&[u8],b:&[u8]){assert_fields(&scene(a),&scene(b));assert_eq!(geometry_words(a),geometry_words(b));}
