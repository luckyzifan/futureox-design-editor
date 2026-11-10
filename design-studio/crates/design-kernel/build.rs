use std::path::Path;

fn main() {
    let manifest = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    let card = manifest.join("testing/verification-interaction-layout-20261030/fig-card-corners.bin");
    let posting = manifest.join("testing/verification-interaction-layout-20261030/fig-posting-corners.bin");
    optional_cfg(
        "futureox_has_fig_corner_blobs",
        &card,
        card.is_file() && posting.is_file(),
    );
    println!("cargo::rerun-if-changed={}", posting.display());
    let official = manifest.join("testing/fixtures/sketch-official/reference-files/files");
    optional_cfg("futureox_has_sketch_official_files", &official, official.is_dir());
}

fn optional_cfg(name: &str, path: &Path, present: bool) {
    println!("cargo::rerun-if-changed={}", path.display());
    println!("cargo::rustc-check-cfg=cfg({name})");
    if present {
        println!("cargo::rustc-cfg={name}");
    }
}
