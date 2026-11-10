use std::path::Path;

fn main() {
    generate_preparation_methods();
    let manifest = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    let card = manifest.join("testing/fixtures/design/fig-card-corners.bin");
    let posting = manifest.join("testing/fixtures/design/fig-posting-corners.bin");
    optional_cfg(
        "futureox_has_fig_corner_blobs",
        &card,
        card.is_file() && posting.is_file(),
    );
    println!("cargo::rerun-if-changed={}", posting.display());
    let official = manifest.join("testing/fixtures/sketch-official/reference-files/files");
    optional_cfg(
        "futureox_has_sketch_official_files",
        &official,
        official.is_dir(),
    );
}

fn protocol_json(source: &str) -> String {
    let header = "export const preparationProtocol = ";
    let footer = "\n} as const\n";
    assert!(source.starts_with(header), "preparation protocol header");
    let end = source.find(footer).expect("preparation protocol footer");
    source[header.len()..end + 2].to_string()
}

fn method_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn generate_preparation_methods() {
    let path = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../frontend/design-desktop/src/preparation-methods-v1.ts");
    println!("cargo::rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("preparation protocol {}: {error}", path.display()));
    let value: serde_json::Value =
        serde_json::from_str(&protocol_json(&text)).expect("preparation protocol json");
    let root = value.as_object().expect("preparation protocol object");
    let keys: Vec<_> = root.keys().cloned().collect();
    assert!(
        keys.len() == 3
            && ["codecMethods", "methods", "protocol"]
                .iter()
                .all(|key| root.contains_key(*key)),
        "preparation protocol keys"
    );
    assert_eq!(root["protocol"], 1, "preparation protocol version");
    let methods = root["methods"].as_array().expect("preparation methods");
    assert!(!methods.is_empty(), "preparation methods");
    let mut names = std::collections::BTreeSet::new();
    let mut generated = String::from("pub static PREPARATION_METHODS: &[&str] = &[\n");
    for (index, method) in methods.iter().enumerate() {
        let fields = method.as_object().expect("preparation method");
        let field_names: Vec<_> = fields.keys().cloned().collect();
        assert!(
            field_names.len() == 5
                && ["browser", "code", "dispatch", "host", "name"]
                    .iter()
                    .all(|key| fields.contains_key(*key)),
            "preparation method fields"
        );
        let name = fields["name"].as_str().expect("preparation method name");
        assert!(method_name(name), "preparation method name {name}");
        assert!(names.insert(name), "duplicate preparation method {name}");
        assert_eq!(
            fields["code"],
            index as u64 + 1,
            "preparation method code {name}"
        );
        let dispatch = fields["dispatch"].as_str().expect("dispatch");
        assert!(
            dispatch == "all" || dispatch == "native",
            "preparation dispatch {name}"
        );
        let browser = fields["browser"].as_bool().expect("browser");
        let host = fields["host"].as_str().expect("host");
        assert!(
            host == "renderer" || host == "private" || host == "none",
            "preparation host {name}"
        );
        assert!(
            !(browser && (host != "renderer" || dispatch != "all")),
            "browser preparation method {name} requires shared renderer admission"
        );
        generated.push_str(&format!("    \"{name}\",\n"));
    }
    let codecs = root["codecMethods"].as_array().expect("codec methods");
    assert!(!codecs.is_empty(), "codec methods");
    let mut codec_names = std::collections::BTreeSet::new();
    for codec in codecs {
        let name = codec.as_str().expect("codec method");
        assert!(method_name(name), "codec method {name}");
        assert!(
            !names.contains(name) && codec_names.insert(name),
            "codec method {name}"
        );
    }
    generated.push_str("];\npub fn known_preparation_method(method: &str) -> bool {\n    PREPARATION_METHODS.contains(&method)\n}\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("preparation_methods.rs");
    std::fs::write(out, generated).expect("write preparation methods");
}

fn optional_cfg(name: &str, path: &Path, present: bool) {
    println!("cargo::rerun-if-changed={}", path.display());
    println!("cargo::rustc-check-cfg=cfg({name})");
    if present {
        println!("cargo::rustc-cfg={name}");
    }
}
