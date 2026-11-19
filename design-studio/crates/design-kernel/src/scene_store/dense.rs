//! Authenticated sequential source loading. Decode neighbouring bounded
//! batches independently, then restore references in their original order.
use super::*;
use std::{
    io::BufRead,
    sync::mpsc::{self, RecvTimeoutError},
    time::Duration,
};

const BATCH_BYTES: u64 = 1024 * 1024;
const BATCH_ROWS: usize = 256;

struct Scan<'a> {
    input: BufReader<RangeReader<'a>>,
    remaining: u64,
    end: u64,
    limit: u64,
    merkle: MerkleFold,
    pending: Option<Row>,
}

impl Scan<'_> {
    fn next(&mut self, cancel: &AtomicBool) -> io::Result<Vec<Row>> {
        let mut rows: Vec<Row> = Vec::new();
        while rows.len() < BATCH_ROWS {
            check(cancel)?;
            let row = if let Some(row) = self.pending.take() {
                row
            } else {
                if self.remaining == 0 {
                    break;
                }
                let mut bytes = [0; 96];
                self.input.read_exact(&mut bytes)?;
                self.merkle.push(sha(&bytes));
                let row = Row::decode(bytes);
                if row.key_offset != self.end
                    || row.key_bytes == 0
                    || row.value_bytes == 0
                    || sum(row.key_offset, row.key_bytes)? != row.value_offset
                {
                    return Err(invalid("Noncontiguous scene records"));
                }
                self.end = sum(row.value_offset, row.value_bytes)?;
                if self.end > self.limit {
                    return Err(invalid("Scene node overlaps index"));
                }
                self.remaining -= 1;
                row
            };
            if let Some(first) = rows.first()
                && row_end(row) - first.key_offset > BATCH_BYTES
            {
                self.pending = Some(row);
                break;
            }
            rows.push(row);
        }
        Ok(rows)
    }
}

fn row_end(row: Row) -> u64 {
    // Scan checked the complete range before exposing a row.
    row.value_offset + row.value_bytes
}

fn bounded(rows: &[Row]) -> bool {
    rows.first()
        .zip(rows.last())
        .is_some_and(|(first, last)| row_end(*last) - first.key_offset <= BATCH_BYTES)
}

type Decoded = Vec<(NodeRecord, u64)>;

fn decode(
    file: &File,
    rows: &[Row],
    shared: bool,
    decoder: Decoder,
    cancel: &AtomicBool,
) -> io::Result<Decoded> {
    let Some((first, last)) = rows.first().zip(rows.last()) else {
        return Ok(Vec::new());
    };
    let mut data = BufReader::with_capacity(
        64 * 1024,
        RangeReader {
            file,
            position: first.key_offset,
            end: row_end(*last),
        },
    );
    let mut key_scratch = Vec::new();
    let mut value_scratch = Vec::new();
    let mut decoded = Vec::with_capacity(rows.len());
    for row in rows {
        check(cancel)?;
        let size = usize::try_from(row.key_bytes)
            .map_err(|_| invalid("Scene key cannot be addressed"))?;
        let mut large_key = Vec::new();
        let key = if size <= 256 { &mut key_scratch } else { &mut large_key };
        key.try_reserve_exact(size.saturating_sub(key.len()))
            .map_err(io::Error::other)?;
        key.resize(size, 0);
        data.read_exact(key)?;
        if sha(key) != row.key_hash {
            return Err(invalid("Scene node key changed"));
        }
        let key = std::str::from_utf8(key).map_err(io::Error::other)?;
        let buffered = usize::try_from(row.value_bytes)
            .ok()
            .and_then(|len| data.buffer().get(..len));
        let record = if let Some(bytes) = buffered {
            if sha(bytes) != row.value_hash {
                return Err(invalid("Scene record content changed"));
            }
            let record = if shared {
                unpack_record(decoder.parse(bytes)?)?
            } else {
                NodeRecord {
                    node: decoder.parse(bytes)?,
                    images: vec![],
                    geometry: None,
                    vectors: None,
                }
            };
            let len = bytes.len();
            check(cancel)?;
            data.consume(len);
            record
        } else {
            read_node_record(
                &mut data, row.value_bytes, row.value_hash, shared, cancel,
                &mut value_scratch, decoder,
            )?
        };
        if record.node.id != key {
            return Err(invalid("Scene node identity changed"));
        }
        decoded.push((record, row.value_bytes));
    }
    Ok(decoded)
}

struct Assembly<'a> {
    nodes: BTreeMap<String, Node>,
    images: &'a mut SharedImages,
    geometries: &'a mut SharedGeometry,
    stats: &'a mut ReadStats,
}

impl Assembly<'_> {
    fn append(&mut self, batch: Decoded, cancel: &AtomicBool) -> io::Result<()> {
        for (record, bytes) in batch {
            check(cancel)?;
            if self.nodes.last_key_value().is_some_and(|(last, _)| last >= &record.node.id) {
                return Err(invalid("Scene index order changed"));
            }
            let node = restore_record(record, self.images, self.geometries)?;
            self.stats.key_reads += 1;
            self.stats.node_reads += 1;
            self.stats.node_bytes = sum(self.stats.node_bytes, bytes)?;
            self.nodes.insert(node.id.clone(), node);
        }
        Ok(())
    }
}

pub(super) fn read(reader: &mut Reader, cancel: &AtomicBool, parallel: bool) -> io::Result<BTreeMap<String, Node>> {
    let file = &reader.file;
    let decoder = reader.node_decoder;
    let shared = reader.shared;
    let mut scan = Scan {
        input: BufReader::new(RangeReader {
            file,
            position: reader.index_offset,
            end: reader.tree_offset,
        }),
        remaining: reader.nodes,
        end: reader.metadata_end,
        limit: reader.index_offset,
        merkle: MerkleFold::new(),
        pending: None,
    };
    let mut assembly = Assembly {
        nodes: BTreeMap::new(),
        images: &mut reader.images,
        geometries: &mut reader.geometries,
        stats: &mut reader.stats,
    };
    let parallel = parallel && reader.index_offset - reader.metadata_end >= 8 * BATCH_BYTES
        && std::thread::available_parallelism().is_ok_and(|count| count.get() > 1);
    let decode_local = |rows: &[Row]| decode(file, rows, shared, decoder, cancel);
    std::thread::scope(|scope| -> io::Result<()> {
        let stop = Arc::new(AtomicBool::new(false));
        let worker = if parallel {
            let (send, receive) = mpsc::sync_channel::<Vec<Row>>(0);
            let (reply, result) = mpsc::sync_channel(1);
            let stop = stop.clone();
            std::thread::Builder::new()
                .spawn_scoped(scope, move || {
                    let _cancel = crate::render_cancellation::SharedCancelGuard::bind(stop);
                    while let Ok(rows) = receive.recv() {
                        if reply.send(decode(file, &rows, shared, decoder, cancel)).is_err() {
                            break;
                        }
                    }
                })
                .ok()
                .map(|worker| (send, result, worker))
        } else {
            None
        };
        let outcome = (|| -> io::Result<()> {
            let mut first = scan.next(cancel)?;
            while !first.is_empty() {
                if let Some((send, ready, _)) = &worker
                    && bounded(&first)
                {
                    let second = scan.next(cancel)?;
                    if bounded(&second) {
                        send.send(first).map_err(|_| io::Error::other("Scene decode worker stopped"))?;
                        let second = decode_local(&second)?;
                        let earlier = loop {
                            check(cancel)?;
                            match ready.recv_timeout(Duration::from_millis(4)) {
                                Ok(batch) => break batch?,
                                Err(RecvTimeoutError::Timeout) => continue,
                                Err(RecvTimeoutError::Disconnected) => {
                                    return Err(io::Error::other("Scene decode worker stopped"));
                                }
                            }
                        };
                        assembly.append(earlier, cancel)?;
                        assembly.append(second, cancel)?;
                        first = scan.next(cancel)?;
                    } else {
                        // A single large record keeps the existing streaming
                        // reader and runs without another decode in flight.
                        assembly.append(decode_local(&first)?, cancel)?;
                        first = second;
                    }
                } else {
                    assembly.append(decode_local(&first)?, cancel)?;
                    first = scan.next(cancel)?;
                }
            }
            Ok(())
        })();
        stop.store(true, Ordering::Release);
        if let Some((send, result, worker)) = worker {
            drop(send);
            drop(result);
            worker.join().map_err(|_| io::Error::other("Scene decode worker failed"))?;
        }
        outcome
    })?;
    for _ in reader.nodes..reader.leaf_base {
        check(cancel)?;
        scan.merkle.push([0; 32]);
    }
    if scan.end != scan.limit || scan.merkle.root() != Some(reader.index_root) {
        return Err(invalid("Scene store index changed"));
    }
    check(cancel)?;
    assembly.stats.index_bytes_verified =
        sum(assembly.stats.index_bytes_verified, reader.nodes * ROW_BYTES)?;
    Ok(assembly.nodes)
}
