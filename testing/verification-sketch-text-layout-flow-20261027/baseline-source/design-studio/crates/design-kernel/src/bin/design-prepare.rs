//! Owned desktop child: bounded NDJSON requests, binary framed replies.
use futureox_design_kernel::preparation::Preparation;
mod transport;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u32,
    lane: String,
    method: String,
    args: Vec<Value>,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--font") {
        return Err("--font required".into());
    }
    let font = std::fs::read(args.next().ok_or("font path required")?)?;
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    let mut session = Preparation::new(&font)?;
    // The bounded reader remains available while Rust computes. Only a
    // stateless packet request receives a cancellation flag; ordered edits and
    // exact exports cannot be cancelled by a late control message.
    let (sender, receiver) = mpsc::sync_channel::<Result<(Request, Arc<AtomicBool>), String>>(1);
    std::thread::spawn(move || {
        let run = || -> Result<(), String> {
            #[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Cancel { cancel:u32 }
            let stdin=io::stdin();let mut input=stdin.lock();
            let mut assembler=transport::Assembler::default();
            let mut last:Option<(u32,Arc<AtomicBool>)>=None;
            loop {
                let mut frame=Vec::new();
                let n=std::io::Read::take(&mut input,68*1024*1024+1).read_until(b'\n',&mut frame).map_err(|e|e.to_string())?;
                if n==0 {return if assembler.incomplete(){Err("Incomplete preparation transfer".into())}else{Ok(())}}
                if n>68*1024*1024||frame.last()!=Some(&b'\n'){return Err("Invalid preparation frame size".into())}
                if frame.len()<=64 {
                    if let Ok(cancel)=serde_json::from_slice::<Cancel>(&frame){
                        if let Some((id,flag))=&last {if *id==cancel.cancel{flag.store(true,Ordering::Release)}}
                        continue
                    }
                }
                let Some(frame)=assembler.accept(frame,transport::transfer_byte_limit()).map_err(|e|e.to_string())?else{continue};
                let request:Request=serde_json::from_slice(&frame).map_err(|e|e.to_string())?;
                if request.id==0||request.args.len()>3{return Err("Invalid preparation request".into())}
                let flag=Arc::new(AtomicBool::new(false));
                last=(request.method=="compile_gpu_packet").then(||(request.id,flag.clone()));
                if sender.send(Ok((request,flag))).is_err(){return Ok(())}
            }
        };
        if let Err(error)=run(){let _=sender.send(Err(error));}
    });
    let stdout=io::stdout();let mut output=stdout.lock();
    for incoming in receiver {
        let (request, cancelled)=incoming?;
        let (mut metadata, bytes) =
            match futureox_design_kernel::render_cancellation::with_probe(move || cancelled.load(Ordering::Acquire),
                || session.request(&request.lane, &request.method, &request.args)) {
                Ok(reply) => (reply.metadata, reply.bytes),
                Err(error) => (json!({"error":error}), Vec::new()),
            };
        metadata["id"] = json!(request.id);
        let metadata = serde_json::to_vec(&metadata)?;
        output.write_all(b"FPR1")?;
        output.write_all(&u32::try_from(metadata.len())?.to_le_bytes())?;
        output.write_all(&u32::try_from(bytes.len())?.to_le_bytes())?;
        output.write_all(&metadata)?;
        output.write_all(&bytes)?;
        output.flush()?;
    }
    Ok(())
}
