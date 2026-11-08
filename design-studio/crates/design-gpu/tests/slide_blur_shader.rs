#[test]
fn sliding_box_shader_parses() {
    let source = include_str!("../../design-kernel/shaders/slide-blur.wgsl");
    naga::front::wgsl::parse_str(source).expect("slide-blur.wgsl");
}
