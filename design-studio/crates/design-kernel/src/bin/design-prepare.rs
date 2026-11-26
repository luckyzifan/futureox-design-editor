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
    #[serde(rename="sourceBitmaps",default)]
    source_bitmaps:Option<futureox_design_kernel::source_bitmap_pixels::Directory>,
}
#[cfg(target_os = "macos")]
fn pack_pose_packet(bytes: &[u8]) -> Option<Vec<u8>> {
    // The SDK exposes a raw LZ4 block; the renderer uses the same raw block
    // decoder on every host. An incompressible packet stays inline.
    const LZ4_RAW: u32 = 0x101;
    #[link(name = "compression")]
    unsafe extern "C" {
        fn compression_encode_buffer(
            destination: *mut u8,
            destination_bytes: usize,
            source: *const u8,
            source_bytes: usize,
            scratch: *mut std::ffi::c_void,
            algorithm: u32,
        ) -> usize;
    }
    let mut destination = vec![0; bytes.len() * 3 / 4];
    // Both buffers are live and disjoint. The SDK bounds all writes by the
    // supplied destination length; null scratch requests framework storage.
    let size = unsafe {
        compression_encode_buffer(destination.as_mut_ptr(), destination.len(),
            bytes.as_ptr(), bytes.len(), std::ptr::null_mut(), LZ4_RAW)
    };
    if size == 0 || size >= destination.len() { return None; }
    destination.truncate(size);
    Some(destination)
}
#[cfg(not(target_os = "macos"))]
fn pack_pose_packet(_bytes: &[u8]) -> Option<Vec<u8>> { None }

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--font") {
        return Err("--font required".into());
    }
    let font = std::fs::read(args.next().ok_or("font path required")?)?;
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    let detailed_diagnostics = std::env::var("CORE_RENDER_DIAGNOSTICS").as_deref() == Ok("detail");
    let mut session = Preparation::new(&font)?;
    session.enable_local_sketch_ui();
    // The bounded reader remains available while Rust computes. A stateless
    // packet and an in-flight CPU frame can be cancelled; ordered edits and
    // exact exports cannot. A cancelled frame keeps tiles it already committed.
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
                last = matches!(request.method.as_str(), "compile_gpu_packet" | "render_cpu_frame")
                    .then(|| (request.id, flag.clone()));
                if sender.send(Ok((request,flag))).is_err(){return Ok(())}
            }
        };
        if let Err(error)=run(){let _=sender.send(Err(error));}
    });
    let stdout=io::stdout();let mut output=stdout.lock();
    for incoming in receiver {
        let (request, cancelled)=incoming?;
        let probe = Arc::clone(&cancelled);
        let (mut metadata, mut bytes) =
            match futureox_design_kernel::render_cancellation::with_probe(move || probe.load(Ordering::Acquire),
                || match request.source_bitmaps {
                    Some(grant)=>session.render_with_bitmaps(&request.lane,&request.method,&request.args,grant),
                    None=>session.request(&request.lane,&request.method,&request.args),
                }) {
                Ok(reply) => (reply.metadata, reply.bytes),
                Err(error) => (json!({"error":error}), Vec::new()),
            };
        let pack = metadata.as_object_mut().and_then(|fields| fields.remove("packPose"))
            .and_then(|value| value.as_bool()) == Some(true);
        if pack && !cancelled.load(Ordering::Acquire) && (262_144..=33_554_432).contains(&bytes.len()) {
            let encoding = metadata["compileStats"]["nativeEncodeMs"].as_f64();
            let start = encoding.map(|_| std::time::Instant::now());
            if let Some(packed) = pack_pose_packet(&bytes) {
                metadata["unpackedPoseBytes"] = json!(bytes.len());
                bytes = packed;
            }
            if let (Some(encoding), Some(start)) = (encoding, start) {
                metadata["compileStats"]["nativeEncodeMs"] = json!(encoding + start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        if request.method == "compile_gpu_packet" && cancelled.load(Ordering::Acquire) {
            // The canceled consumer never acknowledges this reply. Complete
            // the physical job without sending the abandoned geometry body.
            metadata = json!({"error":"PREVIEW_CANCELLED"});
            bytes.clear();
        }
        if detailed_diagnostics
            && request.lane == "interaction"
            && request.method == "compile_gpu_packet"
            && let Some(stats) = metadata.get_mut("compileStats").and_then(Value::as_object_mut)
        {
            // Count the FPR1 payload after any native transport packing.
            stats.insert("nativeWireBytes".into(), json!(bytes.len()));
        }
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
