//! The shared compositor shader must parse after the compact image-address branch.
//! This is a frontend check, not a hardware draw or pixel proof.

fn validate(label: &str, source: &str) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|error| panic!("{label} failed to parse: {error:?}"));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .unwrap_or_else(|error| panic!("{label} failed to validate: {error:?}"));
}

#[test]
fn float_and_byte_vector_shaders_parse() {
    validate(
        "float vector shader",
        futureox_design_kernel::gpu::VECTOR_SHADER,
    );
    validate(
        "byte vector shader",
        futureox_design_kernel::gpu::BYTE_VECTOR_SHADER,
    );
}
