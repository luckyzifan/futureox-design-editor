//! Native input-only decoder selection. Canonical output, receipts and hashes
//! continue to use serde_json. The alternative is explicit and opt-in twice:
//! compile feature plus runtime selection, so an A/B cannot silently use serde.
use serde::de::DeserializeOwned;
use std::io;

#[derive(Clone, Copy)]
pub(super) enum Decoder {
    Serde,
    #[cfg(feature = "native-sonic-json")]
    Sonic,
}
impl Decoder {
    pub(super) fn configured() -> io::Result<Self> {
        match std::env::var("CORE_NATIVE_JSON_DECODER").as_deref() {
            Err(std::env::VarError::NotPresent) | Ok("serde") => Ok(Self::Serde),
            #[cfg(feature = "native-sonic-json")]
            Ok("sonic") => Ok(Self::Sonic),
            #[cfg(not(feature = "native-sonic-json"))]
            Ok("sonic") => Err(io::Error::other("Native sonic JSON decoder was not compiled")),
            _ => Err(io::Error::other("Invalid CORE_NATIVE_JSON_DECODER; expected serde or sonic")),
        }
    }
    pub(super) fn parse<T: DeserializeOwned>(self, bytes: &[u8]) -> io::Result<T> {
        match self {
            Self::Serde => serde_json::from_slice(bytes).map_err(io::Error::other),
            #[cfg(feature = "native-sonic-json")]
            Self::Sonic => match sonic_rs::from_slice(bytes) {
                Ok(value) => Ok(value),
                // A candidate rejection retains the established compatibility
                // fallback and error diagnostics, including serde attributes.
                Err(_) => serde_json::from_slice(bytes).map_err(io::Error::other),
            },
        }
    }
}
