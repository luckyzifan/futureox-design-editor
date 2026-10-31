//! Transport frames for realtime document sync.
//!
//! Wire shape follows the two-plane split observed in production editors:
//! a text control plane of JSON envelopes (`ping`, `ack`, `mutations`) and a
//! binary data plane of compressed op batches.  Clients negotiate the
//! protocol version and features up front so old payloads stay decodable.
use crate::ops::Op;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Feature flags mirror query-parameter negotiation on the sync channel;
/// unknown flags must not break frame decoding.
pub const FEATURES: [&str; 3] = ["op-batch", "lz4-frames", "binary-doc"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "messageType", rename_all = "camelCase")]
pub enum Envelope {
    Ping,
    Ack,
    /// Metadata-rich control message, e.g. pending server-side mutations
    /// denormalized into one payload.
    DenormalizedMutations {
        count: usize,
    },
    Ops {
        revision: u64,
        compressed: bool,
    },
    /// Presence-plane messages carried on the same channel: cursor moves
    /// and session liveness are small high-frequency binary frames.
    Presence {
        session: u64,
    },
    /// Live-subscription plane (metadata graph): subscribe by named view
    /// with hashed arguments; the server answers `view_loaded` and pushes
    /// `denormalized_mutations` for that view.
    Subscribe {
        view_name: String,
        view_hash: String,
    },
    Unsubscribe {
        view_name: String,
    },
    ViewLoaded {
        view_name: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Compression {
    None,
    Lz4,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Text {
        envelope: Envelope,
        json: String,
    },
    Binary {
        revision: u64,
        compression: Compression,
        payload: Vec<u8>,
    },
}

#[derive(Debug)]
pub enum FrameError {
    Malformed(String),
    UnknownCompression(u8),
    Decompress(String),
    Json(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Malformed(m) => write!(f, "malformed frame: {m}"),
            FrameError::UnknownCompression(b) => write!(f, "unknown compression tag {b}"),
            FrameError::Decompress(m) => write!(f, "decompression failed: {m}"),
            FrameError::Json(m) => write!(f, "json payload error: {m}"),
        }
    }
}

/// Encode an op batch as a binary frame payload.
pub fn encode_ops_frame(ops: &[Op], revision: u64, compression: Compression) -> Frame {
    let json = serde_json::to_vec(ops).expect("ops serialize");
    let mut body = Vec::with_capacity(json.len() + 8);
    let mut head = crate::binfmt::Writer::new();
    head.varuint(revision);
    body.extend_from_slice(head.body());
    body.extend_from_slice(&json);
    let (compression, payload) = match compression {
        Compression::None => (Compression::None, body),
        Compression::Lz4 => (Compression::Lz4, lz4_flex::compress_prepend_size(&body)),
    };
    Frame::Binary {
        revision,
        compression,
        payload,
    }
}

/// Decode a binary frame back into ops.
pub fn decode_ops_frame(frame: &Frame) -> Result<(u64, Vec<Op>), FrameError> {
    let Frame::Binary {
        compression,
        payload,
        ..
    } = frame
    else {
        return Err(FrameError::Malformed("expected binary frame".into()));
    };
    const LIMIT: usize = 32 * 1024 * 1024;
    if payload.len() > LIMIT {
        return Err(FrameError::Malformed("op frame byte limit".into()));
    }
    if matches!(compression, Compression::Lz4)
        && (payload.len() < 4
            || u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize > LIMIT)
    {
        return Err(FrameError::Malformed("expanded op frame byte limit".into()));
    }
    let body = match compression {
        Compression::None => payload.clone(),
        Compression::Lz4 => lz4_flex::decompress_size_prepended(payload)
            .map_err(|e| FrameError::Decompress(e.to_string()))?,
    };
    let mut head_reader = crate::binfmt::Reader::for_body(&body);
    let revision = head_reader
        .varuint()
        .map_err(|e| FrameError::Malformed(e.to_string()))?;
    let ops = serde_json::from_slice(&body[head_reader.consumed()..])
        .map_err(|e| FrameError::Json(e.to_string()))?;
    Ok((revision, ops))
}

/// The control-plane text representation of a frame.
pub fn envelope_json(envelope: &Envelope) -> String {
    serde_json::to_string(envelope).expect("envelope serializes")
}

pub fn parse_envelope(json: &str) -> Result<Envelope, FrameError> {
    serde_json::from_str(json).map_err(|e| FrameError::Json(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;

    fn ops() -> Vec<Op> {
        vec![
            Op::SetName {
                id: "f1".into(),
                name: "Hello".into(),
            },
            Op::SetOpacity {
                id: "f1".into(),
                opacity: 0.35,
            },
            Op::InsertNode {
                parent: "p1".into(),
                index: 0,
                node: sample_node("x1", "rect"),
            },
        ]
    }

    #[test]
    fn envelope_round_trips() {
        let ping = envelope_json(&Envelope::Ping);
        assert_eq!(parse_envelope(&ping).unwrap(), Envelope::Ping);
        let ack = envelope_json(&Envelope::Ack);
        assert_eq!(ack, r#"{"messageType":"ack"}"#);
        let mutations = envelope_json(&Envelope::DenormalizedMutations { count: 3 });
        assert!(mutations.contains(r#""messageType":"denormalizedMutations""#));
    }

    #[test]
    fn binary_frame_round_trips_uncompressed() {
        let frame = encode_ops_frame(&ops(), 7, Compression::None);
        let (revision, decoded) = decode_ops_frame(&frame).unwrap();
        assert_eq!(revision, 7);
        assert_eq!(decoded, ops());
    }

    #[test]
    fn lz4_frame_round_trips_and_shrinks_repetitive_batches() {
        let mut batch = Vec::new();
        for i in 0..200 {
            batch.push(Op::SetName {
                id: format!("frame-{i}"),
                name: "Repetitive long node name".into(),
            });
        }
        let frame = encode_ops_frame(&batch, 9, Compression::Lz4);
        let (_, decoded) = decode_ops_frame(&frame).unwrap();
        assert_eq!(decoded, batch);
        let raw: usize = batch
            .iter()
            .map(|op| serde_json::to_vec(op).unwrap().len())
            .sum();
        if let Frame::Binary { payload, .. } = frame {
            assert!(
                payload.len() < raw,
                "lz4 payload {} should beat raw {}",
                payload.len(),
                raw
            );
        }
    }

    #[test]
    fn corrupt_compressed_frame_is_reported() {
        let frame = encode_ops_frame(&ops(), 1, Compression::Lz4);
        if let Frame::Binary {
            mut payload,
            revision,
            compression,
        } = frame
        {
            let last = payload.len() - 1;
            payload[last] ^= 0xff;
            let damaged = Frame::Binary {
                revision,
                compression,
                payload,
            };
            assert!(decode_ops_frame(&damaged).is_err());
        }
    }

    #[test]
    fn livegraph_and_presence_envelopes_round_trip() {
        let subscribe = envelope_json(&Envelope::Subscribe {
            view_name: "SubscribedLibrariesForFile".into(),
            view_hash: "f25ed3eceb85".into(),
        });
        assert_eq!(
            parse_envelope(&subscribe).unwrap(),
            Envelope::Subscribe {
                view_name: "SubscribedLibrariesForFile".into(),
                view_hash: "f25ed3eceb85".into()
            }
        );
        let loaded = envelope_json(&Envelope::ViewLoaded {
            view_name: "CurrentTeamCombinedPermissions".into(),
        });
        assert!(loaded.contains(r#""messageType":"viewLoaded""#));
        let presence = envelope_json(&Envelope::Presence { session: 354 });
        assert!(presence.contains(r#""messageType":"presence""#));
    }

    #[test]
    fn text_frame_rejects_binary_decode() {
        assert!(
            decode_ops_frame(&Frame::Text {
                envelope: Envelope::Ack,
                json: String::new()
            })
            .is_err()
        );
    }
}
