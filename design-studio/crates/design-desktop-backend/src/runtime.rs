//! One parser, independent bounded ordinary/large-source lanes, and async stdio.
//! Never spawn an unbounded set of tasks waiting for a semaphore. A running job
//! owns its permit inside the blocking closure, including after caller cancellation.
use crate::{
    Backend, BackendError, MAX_FRAME_BYTES,
    protocol::{self, Request, Response},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};

pub const MAX_PENDING: usize = 8;
fn large_lane(method: &str) -> bool {
    method.starts_with("large.")
        && !matches!(
            method,
            "large.read" | "large.children" | "large.status" | "large.progress" | "large.openingView"
        )
}
async fn scheduling(
    writer: &mut (impl AsyncWrite + Unpin),
    id: &Value,
    phase: &str,
) -> io::Result<()> {
    write_encoded(
        writer,
        &serde_json::to_vec(&json!({"desktopScheduling":{"id":id,"phase":phase}}))
            .map_err(io::Error::other)?,
    )
    .await
}
pub fn max_pending_bytes() -> usize {
    crate::document_transport::transfer_byte_limit().saturating_add(8 * 1024 * 1024)
}
struct Input {
    parsed: std::result::Result<Request, Response>,
    bytes: usize,
}
struct Job {
    request: Request,
    bytes: usize,
}
struct Running {
    id: Value,
    scan: bool,
    cancel: Arc<AtomicBool>,
    bytes: usize,
    join: JoinHandle<io::Result<Vec<u8>>>,
}

async fn read_frame(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> io::Result<Option<(Vec<u8>, bool)>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    let mut saw = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(saw.then_some((bytes, oversized)));
        }
        saw = true;
        let newline = available.iter().position(|&b| b == b'\n');
        let length = newline.unwrap_or(available.len());
        if !oversized {
            if length > MAX_FRAME_BYTES.saturating_sub(bytes.len()) {
                bytes.clear();
                oversized = true;
            } else {
                bytes.extend_from_slice(&available[..length]);
            }
        }
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some((bytes, oversized)));
        }
    }
}
fn encode(response: Response) -> io::Result<Vec<u8>> {
    let bytes = crate::bounded_json(
        &response,
        crate::document_transport::transfer_byte_limit(),
        "FRAME_TOO_LARGE",
    )
    .map_err(io::Error::other)?;
    Ok(bytes)
}
async fn write_encoded(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> io::Result<()> {
    if bytes.len() <= MAX_FRAME_BYTES {
        writer.write_all(bytes).await?;
        writer.write_all(b"\n").await?;
    } else {
        let id = crate::unique_id();
        for offset in (0..bytes.len()).step_by(crate::document_transport::CHUNK_BYTES) {
            writer
                .write_all(&crate::document_transport::chunk(bytes, offset, &id)?)
                .await?;
        }
    }
    writer.flush().await
}
async fn reply(writer: &mut (impl AsyncWrite + Unpin), response: Response) -> io::Result<()> {
    // Control replies are small. Large document response serialization is inside
    // the single blocking worker, before its permit can be released.
    write_encoded(writer, &encode(response)?).await
}
fn failed(id: Value, code: &'static str, message: &str) -> Response {
    protocol::failed(id, BackendError::new(code, message))
}

pub async fn serve<R, W>(backend: Arc<Backend>, reader: R, writer: W) -> io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    let worker_backend = backend.clone();
    serve_impl(
        backend,
        reader,
        writer,
        MAX_PENDING,
        max_pending_bytes(),
        Arc::new(move |request, cancel| protocol::handle_request(&worker_backend, request, cancel)),
    )
    .await
}

type Handler = Arc<dyn Fn(Request, &AtomicBool) -> Response + Send + Sync>;
async fn serve_impl<R, W>(
    backend: Arc<Backend>,
    reader: R,
    mut writer: W,
    max_pending: usize,
    max_bytes: usize,
    handler: Handler,
) -> io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    // An input task may own one parsed frame and one frame in the channel. Thus
    // input staging is at most 2*transfer_byte_limit() in complete payload bytes,
    // separately from the resource-aware admitted-work queue. Individual chunks
    // stay bounded; parsed JSON/model allocation overhead is not an RSS cap.
    let (sender, mut receiver) = mpsc::channel::<io::Result<Input>>(1);
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let input = tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut assembler = crate::document_transport::Assembler::default();
        loop {
            let read = tokio::select! { biased; _=stopped.changed()=>break, read=read_frame(&mut reader)=>read };
            let frame = match read {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    if assembler.incomplete() {
                        let _ = sender
                            .send(Err(io::Error::new(
                                io::ErrorKind::UnexpectedEof,
                                "Incomplete document transfer",
                            )))
                            .await;
                    }
                    break;
                }
                Err(e) => {
                    let _ = sender.send(Err(e)).await;
                    break;
                }
            };
            let frame = if frame.1 {
                if assembler.incomplete() {
                    let _ = sender
                        .send(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Oversized frame interrupted document transfer",
                        )))
                        .await;
                    break;
                }
                frame
            } else {
                // Assembly/parsing work never blocks the Tokio executor. Only
                // one transfer is staged; admission precedes each allocation.
                let limit = crate::document_transport::transfer_byte_limit();
                let (next, assembled) = match tokio::task::spawn_blocking(move || {
                    let result = assembler.accept(frame.0, limit);
                    (assembler, result)
                })
                .await
                {
                    Ok(result) => result,
                    Err(e) => {
                        let _ = sender.send(Err(io::Error::other(e))).await;
                        break;
                    }
                };
                assembler = next;
                match assembled {
                    Ok(Some(bytes)) => (bytes, false),
                    Ok(None) => continue,
                    Err(e) => {
                        let _ = sender.send(Err(e)).await;
                        break;
                    }
                }
            };
            let bytes = frame.0.len();
            let parsed = if frame.1 {
                Err(failed(
                    Value::Null,
                    "FRAME_TOO_LARGE",
                    "IPC frame exceeds 64 MiB",
                ))
            } else {
                // Exactly one parser job is submitted and joined at a time.
                match tokio::task::spawn_blocking(move || protocol::parse_admitted_frame(&frame.0))
                    .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = sender.send(Err(io::Error::other(e))).await;
                        break;
                    }
                }
            };
            tokio::select! { biased; _=stopped.changed()=>break, sent=sender.send(Ok(Input{parsed,bytes}))=>{if sent.is_err(){break;}} }
        }
    });
    let slots = Arc::new(Semaphore::new(2));
    let mut queue = VecDeque::<Job>::new();
    let mut running: Option<Running> = None;
    let mut large_running: Option<Running> = None;
    let mut pending_bytes = 0usize;
    let mut eof = false;
    let mut failure = None;
    loop {
        for (large, lane) in [(false, &mut running), (true, &mut large_running)] {
            if lane.is_some() {
                continue;
            }
            if let Some(index) = queue
                .iter()
                .position(|job| large_lane(&job.request.method) == large)
            {
                let job = queue.remove(index).unwrap();
                if job.request.scheduling {
                    if let Err(error) = scheduling(&mut writer, &job.request.id, "running").await {
                        failure = Some(error);
                        break;
                    }
                }
                let permit = slots
                    .clone()
                    .try_acquire_owned()
                    .expect("at most one worker per lane");
                let id = job.request.id.clone();
                let scan = job.request.method == "catalog.scan"
                    || job.request.method.starts_with("large.");
                let cancel = Arc::new(AtomicBool::new(false));
                let worker_cancel = cancel.clone();
                let worker = handler.clone();
                let join = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    encode(worker(job.request, &worker_cancel))
                });
                *lane = Some(Running {
                    id,
                    scan,
                    cancel,
                    bytes: job.bytes,
                    join,
                });
            }
        }
        if failure.is_some() {
            queue.clear();
            eof = true;
            let _ = stop.send(true);
            receiver.close();
            for job in running.as_ref().into_iter().chain(large_running.as_ref()) {
                if job.scan {
                    job.cancel.store(true, Ordering::Release);
                }
            }
        }
        if eof && running.is_none() && large_running.is_none() && queue.is_empty() {
            break;
        }
        tokio::select! {
            completed=async { (&mut running.as_mut().unwrap().join).await }, if running.is_some()=> {
                let job=running.take().unwrap(); pending_bytes-=job.bytes;
                match completed {
                    Ok(Ok(bytes))=> { if failure.is_none() { if let Err(e)=write_encoded(&mut writer,&bytes).await {failure=Some(e);} } }
                    Ok(Err(e))=>{failure=Some(e);}
                    Err(e)=>{failure=Some(io::Error::other(e));}
                }
            }
            completed=async { (&mut large_running.as_mut().unwrap().join).await }, if large_running.is_some()=> {
                let job=large_running.take().unwrap(); pending_bytes-=job.bytes;
                match completed {
                    Ok(Ok(bytes))=> { if failure.is_none() { if let Err(e)=write_encoded(&mut writer,&bytes).await {failure=Some(e);} } }
                    Ok(Err(e))=>{failure=Some(e);}
                    Err(e)=>{failure=Some(io::Error::other(e));}
                }
            }
            next=receiver.recv(), if !eof && failure.is_none()=> {
                match next {
                    None=>eof=true,
                    Some(Err(e))=>{failure=Some(e);},
                    Some(Ok(input))=> {
                        let response=match input.parsed {
                            Err(response)=>Some(response),
                            Ok(request)=> {
                                if queue.iter().any(|j|j.request.id==request.id) || running.as_ref().into_iter().chain(large_running.as_ref()).any(|j|j.id==request.id) {
                                    Some(failed(request.id,"DUPLICATE_ID","Request ID is already pending"))
                                } else if request.method=="cancel" {
                                    #[derive(serde::Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)] struct Cancel { request_id:Value }
                                    match serde_json::from_value::<Cancel>(request.params) {
                                        Ok(c) if protocol::valid_id(&c.request_id)=> {
                                            let index=queue.iter().position(|j|j.request.id==c.request_id);
                                            let mut cancelled=false; let mut active=false;
                                            if let Some(index)=index { let job=queue.remove(index).unwrap(); pending_bytes-=job.bytes; cancelled=true;
                                                if let Err(e)=reply(&mut writer,failed(job.request.id,"CANCELLED","Queued request cancelled before execution")).await {failure=Some(e);}
                                            } else if let Some(job)=running.as_ref().into_iter().chain(large_running.as_ref()).find(|j|j.id==c.request_id) { active=true; if job.scan { job.cancel.store(true,Ordering::Release); } }
                                            Some(Response{id:request.id,result:Some(json!({"requestId":c.request_id,"cancelled":cancelled,"running":active})),error:None})
                                        }
                                        _=>Some(failed(request.id,"INVALID_REQUEST","cancel requires a valid requestId")),
                                    }
                                } else if matches!(request.method.as_str(), "health" | "large.progress") {
                                    Some(protocol::handle_request(&backend,request,&AtomicBool::new(false)))
                                } else if queue.len()+usize::from(running.is_some())+usize::from(large_running.is_some())>=max_pending || (large_lane(&request.method) && queue.iter().filter(|j|large_lane(&j.request.method)).count()+usize::from(large_running.is_some())>=2) || input.bytes>max_bytes.saturating_sub(pending_bytes) {
                                    Some(failed(request.id,"BUSY","Request count or aggregate wire-byte budget reached; no work started"))
                                } else {
                                    if request.scheduling { if let Err(e)=scheduling(&mut writer,&request.id,"queued").await {failure=Some(e);} }
                                    if failure.is_none(){pending_bytes+=input.bytes;queue.push_back(Job{request,bytes:input.bytes});}
                                    None
                                }
                            }
                        };
                        if let Some(response)=response && failure.is_none() && let Err(e)=reply(&mut writer,response).await {failure=Some(e);}
                    }
                }
            }
        }
        if failure.is_some() {
            // A broken transport stops unstarted writes. Running atomic work is
            // always joined; no abort/cancel falsely promises rollback.
            queue.clear();
            eof = true;
            let _ = stop.send(true);
            receiver.close();
            for job in running.as_ref().into_iter().chain(large_running.as_ref()) {
                if job.scan {
                    job.cancel.store(true, Ordering::Release);
                }
            }
        }
    }
    let _ = stop.send(true);
    receiver.close();
    let _ = input.await;
    if let Some(e) = failure {
        Err(e)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn large_lane_does_not_block_ordered_saves_and_remains_cancellable() {
        let root = std::env::temp_dir().join(format!("large-lanes-{}", crate::unique_id()));
        let backend = Arc::new(Backend::new(&root).unwrap());
        let started = Arc::new(tokio::sync::Notify::new());
        let notify = started.clone();
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let handler: Handler = Arc::new(move |request, cancel| {
            if request.method == "large.open" {
                notify.notify_one();
                let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while !cancel.load(Ordering::Acquire) && std::time::Instant::now() < until {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            } else {
                recorded.lock().unwrap().push(request.id.clone());
            }
            Response {
                id: request.id,
                result: Some(json!({"done":true})),
                error: None,
            }
        });
        let (mut input, read) = tokio::io::duplex(8192);
        let (write, output) = tokio::io::duplex(8192);
        let server = tokio::spawn(serve_impl(backend, read, write, 8, 8192, handler));
        let mut output = BufReader::new(output);
        async fn send(
            input: &mut tokio::io::DuplexStream,
            id: u32,
            method: &str,
            params: Value,
            scheduling: bool,
        ) {
            input
                .write_all(
                    format!(
                        "{}\n",
                        json!({"id":id,"method":method,"params":params,"scheduling":scheduling})
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        async fn read_receipt(output: &mut BufReader<tokio::io::DuplexStream>) -> Value {
            let mut line = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                output.read_line(&mut line),
            )
            .await
            .unwrap()
            .unwrap();
            serde_json::from_str(&line).unwrap()
        }
        send(&mut input, 1, "large.open", json!({}), true).await;
        assert_eq!(
            read_receipt(&mut output).await["desktopScheduling"]["phase"],
            "queued"
        );
        assert_eq!(
            read_receipt(&mut output).await["desktopScheduling"]["phase"],
            "running"
        );
        started.notified().await;
        send(&mut input, 2, "save", json!({}), false).await;
        send(&mut input, 3, "save", json!({}), false).await;
        assert_eq!(read_receipt(&mut output).await["id"], 2);
        assert_eq!(read_receipt(&mut output).await["id"], 3);
        assert_eq!(*calls.lock().unwrap(), vec![json!(2), json!(3)]);
        send(&mut input, 4, "large.export", json!({}), false).await;
        send(&mut input, 5, "large.open", json!({}), false).await;
        assert_eq!(read_receipt(&mut output).await["error"]["code"], "BUSY");
        send(&mut input, 6, "cancel", json!({"requestId":4}), false).await;
        assert_eq!(
            read_receipt(&mut output).await["error"]["code"],
            "CANCELLED"
        );
        assert_eq!(read_receipt(&mut output).await["result"]["cancelled"], true);
        send(&mut input, 7, "cancel", json!({"requestId":1}), false).await;
        let first = read_receipt(&mut output).await;
        let second = read_receipt(&mut output).await;
        assert!(
            [first, second]
                .iter()
                .any(|r| r["id"] == 7 && r["result"]["running"] == true)
        );
        input.shutdown().await.unwrap();
        server.await.unwrap().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn async_multipart_failure_never_dispatches_and_releases_reader() {
        use base64::Engine as _;
        use tokio::io::AsyncReadExt;
        let root = std::env::temp_dir().join(format!("forma-chunk-runtime-{}", crate::unique_id()));
        let backend = Arc::new(Backend::new(&root).unwrap());
        let payload = br#"{"id":1,"method":"save","params":{}}"#;
        let split = 13;
        let chunk = |id: &str, offset: usize, bytes: &[u8]| {
            format!("{}\n", json!({"desktopChunk":{"version":1,"id":id,"total":payload.len(),"offset":offset,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}})).into_bytes()
        };
        let first = chunk("one", 0, &payload[..split]);
        let valid_tail = chunk("one", split, &payload[split..]);
        for (tail, valid) in [
            (Vec::new(), false),
            (first.clone(), false),
            (chunk("two", split, &payload[split..]), false),
            (chunk("one", usize::MAX, &payload[split..]), false),
            (valid_tail, true),
        ] {
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let seen = calls.clone();
            let handler: Handler = Arc::new(move |request, _| {
                seen.fetch_add(1, Ordering::SeqCst);
                Response {
                    id: request.id,
                    result: Some(json!({"committed":true})),
                    error: None,
                }
            });
            let (mut input, read) = tokio::io::duplex(4096);
            let (write, mut output) = tokio::io::duplex(4096);
            let server = tokio::spawn(serve_impl(backend.clone(), read, write, 2, 512, handler));
            input.write_all(&first).await.unwrap();
            input.write_all(&tail).await.unwrap();
            drop(input);
            let mut response = Vec::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                output.read_to_end(&mut response),
            )
            .await
            .unwrap()
            .unwrap();
            let result = server.await.unwrap();
            assert_eq!(result.is_ok(), valid);
            assert_eq!(calls.load(Ordering::SeqCst), usize::from(valid));
            assert_eq!(response.is_empty(), !valid);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn blocking_permit_survives_waiter_abort() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        let (started, ready) = std::sync::mpsc::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let handle = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            started.send(()).unwrap();
            wait.recv().unwrap();
        });
        ready.recv().unwrap();
        handle.abort();
        assert!(slots.clone().try_acquire_owned().is_err());
        finish.send(()).unwrap();
        let _ = handle.await;
        assert!(slots.try_acquire_owned().is_ok());
    }
    #[tokio::test]
    async fn async_frame_reader_preserves_final_unterminated_frame() {
        let mut input = BufReader::new(&b"one\ntwo"[..]);
        assert_eq!(
            read_frame(&mut input).await.unwrap(),
            Some((b"one".to_vec(), false))
        );
        assert_eq!(
            read_frame(&mut input).await.unwrap(),
            Some((b"two".to_vec(), false))
        );
        assert!(read_frame(&mut input).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn bounded_queue_bytes_cancel_health_and_eof_drain() {
        use tokio::io::AsyncBufReadExt;
        let root = std::env::temp_dir().join(format!("forma-runtime-{}", crate::unique_id()));
        let backend = Arc::new(Backend::new(&root).unwrap());
        let started = Arc::new(tokio::sync::Notify::new());
        let notify = started.clone();
        let (release, wait) = std::sync::mpsc::channel();
        let wait = std::sync::Mutex::new(wait);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let handler: Handler = Arc::new(move |request, _| {
            if request.id == 1 {
                notify.notify_one();
                wait.lock().unwrap().recv().unwrap();
            }
            recorded.lock().unwrap().push(request.id.clone());
            Response {
                id: request.id,
                result: Some(json!({"committed":true})),
                error: None,
            }
        });
        let (mut input, read) = tokio::io::duplex(4096);
        let (write, output) = tokio::io::duplex(4096);
        let server = tokio::spawn(serve_impl(backend, read, write, 2, 512, handler));
        async fn send(input: &mut tokio::io::DuplexStream, id: i64, method: &str, params: Value) {
            input
                .write_all(
                    format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes(),
                )
                .await
                .unwrap();
        }
        send(&mut input, 1, "save", json!({})).await;
        started.notified().await;
        send(&mut input, 3, "save", json!({"large":"x".repeat(800)})).await;
        send(&mut input, 2, "save", json!({})).await;
        send(&mut input, 4, "save", json!({})).await;
        send(&mut input, 10, "cancel", json!({"requestId":2})).await;
        send(&mut input, 11, "cancel", json!({"requestId":1})).await;
        send(&mut input, 12, "health", json!({})).await;
        let mut output = BufReader::new(output);
        let mut responses = Vec::<Value>::new();
        for _ in 0..6 {
            let mut line = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                output.read_line(&mut line),
            )
            .await
            .unwrap()
            .unwrap();
            responses.push(serde_json::from_str(&line).unwrap());
        }
        assert_eq!(
            responses.iter().find(|r| r["id"] == 3).unwrap()["error"]["code"],
            "BUSY"
        );
        assert_eq!(
            responses.iter().find(|r| r["id"] == 4).unwrap()["error"]["code"],
            "BUSY"
        );
        assert_eq!(
            responses.iter().find(|r| r["id"] == 2).unwrap()["error"]["code"],
            "CANCELLED"
        );
        assert_eq!(
            responses.iter().find(|r| r["id"] == 11).unwrap()["result"]["running"],
            true
        );
        assert_eq!(
            responses.iter().find(|r| r["id"] == 11).unwrap()["result"]["cancelled"],
            false
        );
        // Released queue capacity is reusable. EOF drains this admitted request.
        send(&mut input, 5, "save", json!({})).await;
        input.shutdown().await.unwrap();
        release.send(()).unwrap();
        for _ in 0..2 {
            let mut line = String::new();
            output.read_line(&mut line).await.unwrap();
            let r: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(r["result"]["committed"], true);
        }
        server.await.unwrap().unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![json!(1), json!(5)]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
