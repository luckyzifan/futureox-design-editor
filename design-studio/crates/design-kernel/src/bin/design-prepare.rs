//! Owned desktop child: bounded NDJSON requests, binary framed replies.
use futureox_design_kernel::preparation::Preparation;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { id:u32, lane:String, method:String, args:Vec<Value> }
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let mut args=std::env::args().skip(1);
    if args.next().as_deref()!=Some("--font") { return Err("--font required".into()); }
    let font=std::fs::read(args.next().ok_or("font path required")?)?;
    if args.next().is_some() { return Err("Unexpected argument".into()); }
    let mut session=Preparation::new(&font)?;
    let stdin=io::stdin(); let mut input=stdin.lock(); let stdout=io::stdout(); let mut output=stdout.lock();
    loop {
        let mut frame=Vec::new();
        // Read through a bounded adapter; a truncated/oversized request retires
        // this disposable renderer instead of consuming unbounded input.
        let n=std::io::Read::take(&mut input, 68*1024*1024+1).read_until(b'\n',&mut frame)?;
        if n==0 { break; }
        if n>68*1024*1024 || frame.last()!=Some(&b'\n') { return Err("Invalid preparation frame size".into()); }
        let request:Request=serde_json::from_slice(&frame)?;
        if request.id==0 || request.args.len()>3 { return Err("Invalid preparation request".into()); }
        let (mut metadata,bytes)=match session.request(&request.lane,&request.method,&request.args) {
            Ok(reply)=>(reply.metadata,reply.bytes),
            Err(error)=>(json!({"error":error}),Vec::new()),
        };
        metadata["id"]=json!(request.id);
        let metadata=serde_json::to_vec(&metadata)?;
        output.write_all(b"FPR1")?;
        output.write_all(&u32::try_from(metadata.len())?.to_le_bytes())?;
        output.write_all(&u32::try_from(bytes.len())?.to_le_bytes())?;
        output.write_all(&metadata)?; output.write_all(&bytes)?; output.flush()?;
    }
    Ok(())
}
