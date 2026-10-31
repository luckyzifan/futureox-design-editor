//! Exact checkpoint-byte budget, independent of document and serde types.
use std::io::{self, Write};

// Writer and recovery admission must agree; this is the existing reader limit.
pub(crate) const MAX_CHECKPOINT_BYTES: u64 = 16 * 1024 * 1024;

// Count the exact UTF-8 JSON stream without allocating a complete checkpoint.
// The same guard also wraps the actual writer, before its buffered bytes can be
// published. Partial underlying writes count only bytes accepted by that writer.
pub(crate) struct CheckpointWriter<W> {
    inner: W,
    written: u64,
}
impl<W> CheckpointWriter<W> {
    pub(crate) fn new(inner: W) -> Self {
        Self { inner, written: 0 }
    }
    pub(crate) fn get_ref(&self) -> &W {
        &self.inner
    }
    #[cfg(test)]
    pub(crate) fn written_bytes(&self) -> u64 {
        self.written
    }
}
impl<W: Write> Write for CheckpointWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self
            .written
            .checked_add(bytes.len() as u64)
            .is_none_or(|total| total > MAX_CHECKPOINT_BYTES)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Local checkpoint exceeds the 16 MiB recovery limit",
            ));
        }
        let written = self.inner.write(bytes)?;
        self.written += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_writer_accepts_exact_limit_and_rejects_next_byte() {
        let mut writer = CheckpointWriter::new(Vec::new());
        writer.written = MAX_CHECKPOINT_BYTES - 2;
        writer.write_all(b"ab").unwrap();
        assert_eq!(writer.written, MAX_CHECKPOINT_BYTES);
        assert_eq!(writer.inner, b"ab");
        let error = writer.write(b"c").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("16 MiB recovery limit"));
        assert_eq!(writer.inner, b"ab");
        assert_eq!(writer.write(b"").unwrap(), 0);

        writer.written = u64::MAX;
        assert!(writer.write(b"x").is_err());
        assert_eq!(writer.inner, b"ab");
    }

    #[test]
    fn checkpoint_writer_accounts_for_partial_writes_and_forwards_io_failures() {
        #[derive(Default)]
        struct ShortWriter {
            bytes: Vec<u8>,
            fail: bool,
        }
        impl Write for ShortWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.fail {
                    return Err(io::Error::other("injected write failure"));
                }
                let n = bytes.len().min(2);
                self.bytes.extend_from_slice(&bytes[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                if self.fail {
                    Err(io::Error::other("injected flush failure"))
                } else {
                    Ok(())
                }
            }
        }
        let mut writer = CheckpointWriter::new(ShortWriter::default());
        writer.written = MAX_CHECKPOINT_BYTES - 4;
        assert_eq!(writer.write(b"abcd").unwrap(), 2);
        assert_eq!(writer.written, MAX_CHECKPOINT_BYTES - 2);
        writer.write_all(b"cd").unwrap();
        assert_eq!(writer.inner.bytes, b"abcd");
        assert!(writer.write(b"e").is_err());
        assert_eq!(writer.inner.bytes, b"abcd");

        let mut failing = CheckpointWriter::new(ShortWriter {
            fail: true,
            ..ShortWriter::default()
        });
        assert!(failing.write(b"x").unwrap_err().to_string().contains("injected"));
        assert_eq!(failing.written, 0);
        assert!(failing.flush().unwrap_err().to_string().contains("injected"));
    }

    #[test]
    fn checkpoint_writer_preserves_write_zero_and_interrupted_contracts() {
        struct Zero;
        impl Write for Zero {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> { Ok(0) }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        let mut zero = CheckpointWriter::new(Zero);
        assert_eq!(zero.write_all(b"x").unwrap_err().kind(), io::ErrorKind::WriteZero);
        assert_eq!(zero.written_bytes(), 0);

        #[derive(Default)]
        struct InterruptedOnce { interrupted: bool, bytes: Vec<u8> }
        impl Write for InterruptedOnce {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        let mut direct = CheckpointWriter::new(InterruptedOnce::default());
        assert_eq!(direct.write(b"x").unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(direct.written_bytes(), 0);
        direct.write_all(b"x").unwrap();
        assert_eq!(direct.written_bytes(), 1);
        assert_eq!(direct.get_ref().bytes, b"x");
        let mut retry = CheckpointWriter::new(InterruptedOnce::default());
        retry.write_all(b"abc").unwrap();
        assert_eq!(retry.written_bytes(), 3);
        assert_eq!(retry.get_ref().bytes, b"abc");
    }
}
