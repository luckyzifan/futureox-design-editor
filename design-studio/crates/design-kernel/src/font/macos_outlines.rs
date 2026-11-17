//! Read-only CoreText outline transport. The bundled helper receives only
//! fixed-size glyph selectors and exits when its parent's stdin pipe closes.
use crate::font_glyph_cache::Command;
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command as Process, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};

const EXECUTABLE: &str = "futureox-sketch-font-outlines";
const MAX_REPLY: usize = 256 * 1024;

fn executable() -> Option<PathBuf> {
    let program = std::env::current_exe().ok()?;
    let directory = program.parent()?;
    let bundled = directory.join(EXECUTABLE);
    if bundled.is_file() { return Some(bundled); }
    #[cfg(test)]
    {
        let test_resource = directory.parent()?.join(EXECUTABLE);
        if test_resource.is_file() { return Some(test_resource); }
    }
    None
}
pub(super) fn available() -> bool { executable().is_some() }

struct Worker {
    child: Child,
    writer: ChildStdin,
    reader: mpsc::Receiver<Vec<u8>>,
}
impl Worker {
    fn new() -> Option<Self> {
        let mut child = Process::new(executable()?)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let writer = child.stdin.take()?;
        let mut reader = BufReader::new(child.stdout.take()?);
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || loop {
            let mut raw = Vec::new();
            if reader.by_ref().take(MAX_REPLY as u64).read_until(b'\n', &mut raw).is_err() ||
                raw.last() != Some(&b'\n') || tx.send(raw).is_err() {
                break;
            }
        });
        Some(Self { child, writer, reader: rx })
    }
    fn request(&mut self, display: bool, glyph: u16, units: i32) -> Result<Option<(Vec<Command>, f64)>, ()> {
        let face = if display { 'D' } else { 'T' };
        writeln!(self.writer, "{face} {glyph}").map_err(|_| ())?;
        self.writer.flush().map_err(|_| ())?;
        let raw = self.reader.recv_timeout(Duration::from_millis(350)).map_err(|_| ())?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply { glyph: u16, units: i32, advance: f64, commands: Vec<Vec<f32>> }
        let Some(reply) = serde_json::from_slice::<Option<Reply>>(&raw).map_err(|_| ())? else { return Ok(None); };
        if reply.glyph != glyph || reply.units != units || !reply.advance.is_finite() ||
            !(0. ..65536.).contains(&reply.advance) || reply.commands.is_empty() || reply.commands.len() > 4096 {
            return Err(());
        }
        let commands = reply.commands.iter().map(|item| {
            if item.iter().any(|value| !value.is_finite() || value.abs() >= 65536.) { return None; }
            match item.as_slice() {
                [0., x, y] => Some(Command::Move(*x, *y)),
                [1., x, y] => Some(Command::Line(*x, *y)),
                [2., a, b, x, y] => Some(Command::Quad(*a, *b, *x, *y)),
                [3., a, b, c, d, x, y] => Some(Command::Cubic(*a, *b, *c, *d, *x, *y)),
                [4.] => Some(Command::Close),
                _ => None,
            }
        }).collect::<Option<Vec<_>>>().ok_or(())?;
        Ok(Some((commands, reply.advance)))
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) fn outline(display: bool, glyph: u16, units: i32) -> Option<(Vec<Command>, f64)> {
    static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
    let mut worker = WORKER.get_or_init(|| Mutex::new(Worker::new())).lock().ok()?;
    match worker.as_mut()?.request(display, glyph, units) {
        Ok(result) => result,
        Err(()) => { *worker = None; None }
    }
}
