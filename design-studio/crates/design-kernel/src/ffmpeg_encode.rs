//! Spawn a caller-supplied FFmpeg executable to mux a PNG sequence.
//!
//! This is native-only. WASM cannot start a process. The desktop host resolves
//! the bundled binary and passes that path in; this module does not search
//! `PATH` and does not accept a shell command.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub const MAX_FRAMES: u32 = 300;
pub const MAX_FPS: u32 = 60;
pub const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoContainer {
    Mp4,
    Webm,
}

impl VideoContainer {
    pub fn extension(self) -> &'static str {
        match self {
            VideoContainer::Mp4 => "mp4",
            VideoContainer::Webm => "webm",
        }
    }
}

/// One encode. Paths are absolute filesystem paths chosen by the trusted host.
#[derive(Clone, Copy)]
pub struct EncodePngSequence<'a> {
    pub ffmpeg: &'a Path,
    pub frames_dir: &'a Path,
    pub output: &'a Path,
    pub container: VideoContainer,
    pub fps: u32,
    pub frame_count: u32,
    pub timeout: Duration,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeReceipt {
    pub bytes: u64,
    pub container: VideoContainer,
}

pub fn encode_png_sequence(
    request: &EncodePngSequence<'_>,
    cancel: &AtomicBool,
) -> Result<EncodeReceipt, String> {
    let plan = encode_plan(request)?;
    if cancel.load(Ordering::Acquire) {
        return Err("Video encode was cancelled".into());
    }
    let mut child = Command::new(&plan.ffmpeg)
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start ffmpeg: {error}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg stderr is unavailable".to_string())?;
    let reader = thread::spawn(move || read_stderr(stderr));
    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("Video encode was cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > request.timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("ffmpeg timed out".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                let _ = child.kill();
                let _ = reader.join();
                return Err(format!("ffmpeg wait failed: {error}"));
            }
        }
    };
    let stderr = reader.join().unwrap_or_default();
    if !status.success() {
        let detail = stderr_text(&stderr);
        return Err(if detail.is_empty() {
            format!("ffmpeg exited {}", status.code().unwrap_or(-1))
        } else {
            format!("ffmpeg exited {}: {detail}", status.code().unwrap_or(-1))
        });
    }
    let meta =
        fs::metadata(&plan.output).map_err(|_| "ffmpeg produced no output file".to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_OUTPUT_BYTES {
        return Err("encoded video is empty or larger than 64 MiB".into());
    }
    let prefix = read_prefix(&plan.output, 64)?;
    if !output_magic_ok(request.container, &prefix) {
        return Err("ffmpeg output is not the requested container".into());
    }
    Ok(EncodeReceipt {
        bytes: meta.len(),
        container: request.container,
    })
}

/// Fixed argv after the executable. Exposed so tests can see that a path is one
/// argument and that the codec flags are not a shell string.
pub fn encode_plan(request: &EncodePngSequence<'_>) -> Result<EncodePlan, String> {
    if request.timeout < Duration::from_millis(1) || request.timeout > MAX_TIMEOUT {
        return Err("invalid encode timeout".into());
    }
    if request.fps < 1 || request.fps > MAX_FPS {
        return Err("frame rate must be from 1 to 60".into());
    }
    if request.frame_count < 1 || request.frame_count > MAX_FRAMES {
        return Err("frame count must be from 1 to 300".into());
    }
    let extension = request.container.extension();
    let output_name = request
        .output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "output file name must be UTF-8".to_string())?;
    if output_name.starts_with('-') || !output_name.ends_with(&format!(".{extension}")) {
        return Err(format!("output file must end in .{extension}"));
    }
    let ffmpeg = require_absolute_file(request.ffmpeg, "ffmpeg")?;
    ensure_executable(&ffmpeg)?;
    let frames_dir = require_absolute_dir(request.frames_dir)?;
    for index in 1..=request.frame_count {
        let frame = frame_path(&frames_dir, index);
        let meta = fs::symlink_metadata(&frame).map_err(|_| format!("frame {index} is missing"))?;
        if !meta.file_type().is_file() {
            return Err(format!("frame {index} is not a regular file"));
        }
        if meta.len() < 8 || meta.len() > MAX_FRAME_BYTES {
            return Err(format!("frame {index} is outside the PNG size bound"));
        }
        let prefix = read_prefix(&frame, 8)?;
        if prefix.as_slice() != b"\x89PNG\r\n\x1a\n" {
            return Err(format!("frame {index} is not a PNG"));
        }
    }
    let output_parent = request
        .output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "output directory is missing".to_string())?;
    let output_parent = require_absolute_dir(output_parent)?;
    let output = output_parent.join(output_name);
    if output.exists() {
        return Err("output already exists".into());
    }
    let pattern = sequence_pattern(&frames_dir)?;
    let output_text = path_text(&output)?;
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-framerate".into(),
        request.fps.to_string(),
        "-start_number".into(),
        "1".into(),
        "-i".into(),
        pattern,
        "-frames:v".into(),
        request.frame_count.to_string(),
        "-vf".into(),
        "pad=ceil(iw/2)*2:ceil(ih/2)*2".into(),
    ];
    match request.container {
        VideoContainer::Mp4 => args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-movflags".into(),
            "+faststart".into(),
        ]),
        VideoContainer::Webm => args.extend([
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-deadline".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "6".into(),
            "-b:v".into(),
            "0".into(),
            "-crf".into(),
            "34".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
    }
    args.push("-an".into());
    args.push(output_text);
    Ok(EncodePlan {
        ffmpeg,
        args,
        output,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodePlan {
    pub ffmpeg: PathBuf,
    pub args: Vec<String>,
    pub output: PathBuf,
}

fn frame_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("frame_{index:06}.png"))
}

fn frame_pattern(dir: &Path) -> PathBuf {
    dir.join("frame_%06d.png")
}

fn sequence_pattern(dir: &Path) -> Result<String, String> {
    path_text(dir)?;
    frame_pattern(dir)
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "path must be UTF-8".to_string())
}

fn path_text(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or_else(|| "path must be UTF-8".to_string())?;
    if text.is_empty()
        || text.contains('%')
        || text.contains('\n')
        || text.contains('\r')
        || text.contains('\0')
    {
        return Err("path contains a character ffmpeg would treat specially".into());
    }
    Ok(text.to_string())
}

fn require_absolute_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    path_text(path)?;
    if !path.is_absolute() {
        return Err(format!("{label} path must be absolute"));
    }
    let canon = fs::canonicalize(path).map_err(|_| format!("{label} is unavailable"))?;
    let meta = fs::symlink_metadata(&canon).map_err(|_| format!("{label} is unavailable"))?;
    if !meta.file_type().is_file() {
        return Err(format!("{label} must be a regular file"));
    }
    path_text(&canon)?;
    Ok(canon)
}

fn require_absolute_dir(path: &Path) -> Result<PathBuf, String> {
    let _ = path_text(path)?;
    if !path.is_absolute() {
        return Err("directory path must be absolute".into());
    }
    let canon = fs::canonicalize(path).map_err(|_| "directory is unavailable".to_string())?;
    if !canon.is_dir() {
        return Err("directory is unavailable".into());
    }
    path_text(&canon)?;
    Ok(canon)
}

fn ensure_executable(path: &Path) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|_| "ffmpeg is unavailable".to_string())?;
    executable_mode(&meta)
}

#[cfg(unix)]
fn executable_mode(meta: &fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if meta.permissions().mode() & 0o111 == 0 {
        return Err("ffmpeg is not executable".into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn executable_mode(_meta: &fs::Metadata) -> Result<(), String> {
    Ok(())
}

fn read_prefix(path: &Path, len: usize) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|_| "could not read file".to_string())?;
    let mut buf = vec![0u8; len];
    let n = file
        .read(&mut buf)
        .map_err(|_| "could not read file".to_string())?;
    buf.truncate(n);
    Ok(buf)
}

fn read_stderr(mut stderr: std::process::ChildStderr) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match stderr.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 2048 {
                    let drop_count = buf.len() - 1024;
                    buf.drain(..drop_count);
                }
            }
        }
    }
    buf
}

fn stderr_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.chars().count() <= 400 {
        trimmed.to_string()
    } else {
        trimmed.chars().take(400).collect()
    }
}

fn output_magic_ok(container: VideoContainer, bytes: &[u8]) -> bool {
    match container {
        VideoContainer::Mp4 => bytes.windows(4).any(|window| window == b"ftyp"),
        VideoContainer::Webm => {
            bytes.len() >= 4
                && bytes[0] == 0x1a
                && bytes[1] == 0x45
                && bytes[2] == 0xdf
                && bytes[3] == 0xa3
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn scratch(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "fx-ffmpeg-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_magic_png(dir: &Path, index: u32) {
        fs::create_dir_all(dir).unwrap();
        fs::write(frame_path(dir, index), b"\x89PNG\r\n\x1a\nnot-a-full-png").unwrap();
    }

    #[cfg(unix)]
    fn write_script(path: &Path, body: &str) {
        fs::write(path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn rejects_relative_paths_rates_and_extensions() {
        let cancel = AtomicBool::new(false);
        let err = encode_png_sequence(
            &EncodePngSequence {
                ffmpeg: Path::new("ffmpeg"),
                frames_dir: Path::new("/tmp"),
                output: Path::new("/tmp/out.mp4"),
                container: VideoContainer::Mp4,
                fps: 12,
                frame_count: 1,
                timeout: Duration::from_secs(1),
            },
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("absolute"), "{err}");
        let err = encode_plan(&EncodePngSequence {
            ffmpeg: Path::new("/tmp/ffmpeg"),
            frames_dir: Path::new("/tmp"),
            output: Path::new("/tmp/out.mp4"),
            container: VideoContainer::Mp4,
            fps: 0,
            frame_count: 1,
            timeout: Duration::from_secs(1),
        })
        .unwrap_err();
        assert!(err.contains("frame rate"), "{err}");
        let err = encode_plan(&EncodePngSequence {
            ffmpeg: Path::new("/tmp/ffmpeg"),
            frames_dir: Path::new("/tmp"),
            output: Path::new("/tmp/out.mp4"),
            container: VideoContainer::Webm,
            fps: 12,
            frame_count: 1,
            timeout: Duration::from_secs(1),
        })
        .unwrap_err();
        assert!(err.contains(".webm"), "{err}");
        let err = encode_plan(&EncodePngSequence {
            ffmpeg: Path::new("/tmp/ffmpeg"),
            frames_dir: Path::new("/tmp"),
            output: Path::new("/tmp/out.mp4"),
            container: VideoContainer::Mp4,
            fps: 12,
            frame_count: 301,
            timeout: Duration::from_secs(1),
        })
        .unwrap_err();
        assert!(err.contains("frame count"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn spawn_uses_one_argument_per_path_and_checks_the_container() {
        let root = scratch("argv");
        let frames = root.join("frames; echo injected");
        fs::create_dir_all(&frames).unwrap();
        write_magic_png(&frames, 1);
        let ffmpeg = root.join("ffmpeg");
        write_script(
            &ffmpeg,
            r#"#!/bin/sh
out=
for arg in "$@"; do
  out=$arg
done
printf '%s\n' "$@" > "$(dirname "$out")/argv.txt"
case "$out" in
  *.webm)
    printf '\032\105\337\243ok' > "$out"
    ;;
  *.mp4)
    printf '\000\000\000\030ftypisom\000\000\000\000isomavc1' > "$out"
    ;;
  *)
    echo 'unexpected output name' >&2
    exit 2
    ;;
esac
"#,
        );
        let output = root.join("motion.mp4");
        let receipt = encode_png_sequence(
            &EncodePngSequence {
                ffmpeg: &ffmpeg,
                frames_dir: &frames,
                output: &output,
                container: VideoContainer::Mp4,
                fps: 12,
                frame_count: 1,
                timeout: Duration::from_secs(5),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(receipt.container, VideoContainer::Mp4);
        assert!(receipt.bytes > 0);
        let argv = fs::read_to_string(root.join("argv.txt")).unwrap();
        let lines: Vec<_> = argv.lines().collect();
        assert!(
            lines.windows(2).any(|pair| pair == ["-c:v", "libx264"]),
            "{argv}"
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("frame_%06d.png"))
                .count(),
            1,
            "{argv}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("frames; echo injected")),
            "{argv}"
        );
        assert!(
            !lines
                .iter()
                .any(|line| *line == "sh" || line.starts_with("sh ")),
            "{argv}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cancel_and_timeout_stop_the_child() {
        let root = scratch("cancel");
        let frames = root.join("frames");
        write_magic_png(&frames, 1);
        let ffmpeg = root.join("ffmpeg");
        write_script(&ffmpeg, "#!/bin/sh\nexec sleep 30\n");
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&cancel);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            flag.store(true, Ordering::Release);
        });
        let err = encode_png_sequence(
            &EncodePngSequence {
                ffmpeg: &ffmpeg,
                frames_dir: &frames,
                output: &root.join("motion.mp4"),
                container: VideoContainer::Mp4,
                fps: 12,
                frame_count: 1,
                timeout: Duration::from_secs(30),
            },
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("cancelled"), "{err}");
        fs::remove_dir_all(&root).unwrap();

        let root = scratch("timeout");
        let frames = root.join("frames");
        write_magic_png(&frames, 1);
        let ffmpeg = root.join("ffmpeg");
        write_script(&ffmpeg, "#!/bin/sh\nexec sleep 30\n");
        let err = encode_png_sequence(
            &EncodePngSequence {
                ffmpeg: &ffmpeg,
                frames_dir: &frames,
                output: &root.join("motion.webm"),
                container: VideoContainer::Webm,
                fps: 12,
                frame_count: 1,
                timeout: Duration::from_millis(200),
            },
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(all(unix, target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn vendored_linux_ffmpeg_encodes_mp4_and_webm() {
        let ffmpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-desktop/vendor/ffmpeg/linux-x64/ffmpeg");
        assert!(ffmpeg.is_file(), "linux-x64 ffmpeg must be vendored");
        let root = scratch("vendor");
        let frames = root.join("frames");
        fs::create_dir_all(&frames).unwrap();
        for (index, rgb) in [(1u32, [220u8, 40, 40]), (2, [40, 40, 220])] {
            fs::write(frame_path(&frames, index), solid_png(8, 8, rgb)).unwrap();
        }
        for container in [VideoContainer::Mp4, VideoContainer::Webm] {
            let output = root.join(format!("motion.{}", container.extension()));
            let receipt = encode_png_sequence(
                &EncodePngSequence {
                    ffmpeg: &ffmpeg,
                    frames_dir: &frames,
                    output: &output,
                    container,
                    fps: 12,
                    frame_count: 2,
                    timeout: Duration::from_secs(60),
                },
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(receipt.container, container);
            assert!(receipt.bytes > 32, "{container:?}");
            let prefix = fs::read(&output).unwrap();
            assert!(output_magic_ok(container, &prefix[..prefix.len().min(64)]));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(all(unix, target_os = "linux", target_arch = "x86_64"))]
    fn solid_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut data = Vec::with_capacity((width * height * 3) as usize);
            for _ in 0..width * height {
                data.extend(rgb);
            }
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&data)
                .unwrap();
        }
        bytes
    }
}
