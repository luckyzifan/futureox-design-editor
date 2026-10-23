mod sketch {
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Archive(String),
    Limit(&'static str),
    Invalid(String),
    Unsupported(String),
    Ambiguous(String),
    Missing(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Sketch archive: {self:?}")
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[path = "/workspace/shared/native-import-policy-20261023T0129Z/clean-e411-source/design-studio/crates/design-kernel/src/sketch/archive.rs"]
pub(crate) mod archive;
}
#[test]
fn actual_archive_roundtrip() {
 let mut files=std::collections::BTreeMap::new();
 files.insert("document.json".to_string(), b"{\"pages\":[]}".to_vec());
 files.insert("pages/p.json".to_string(), b"{}".to_vec());
 let bytes=sketch::archive::write(&files).unwrap();
 assert_eq!(sketch::archive::read(&bytes).unwrap(),files);
 assert!(sketch::archive::read(&bytes[..bytes.len()-1]).is_err());
}
#[test]
fn actual_archive_preserves_path_guard() {
 let mut files=std::collections::BTreeMap::new();files.insert("../escape".into(),vec![1]);
 assert!(matches!(sketch::archive::write(&files),Err(sketch::Error::Invalid(_))));
}
