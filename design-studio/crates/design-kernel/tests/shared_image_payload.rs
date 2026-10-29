use futureox_design_kernel::scene::Paint;
use serde_json::json;

#[test]
fn derived_paint_snapshots_share_image_bytes_and_keep_exact_wire_content() {
    let uri=format!("data:image/png;base64,{}","AAAA".repeat(256*1024));
    let original:Paint=serde_json::from_value(json!({"kind":"image","color":"#ffffff","image":uri})).unwrap();
    let before=serde_json::to_vec(&original).unwrap();
    let mut derived=original.clone();
    // Works with the old String representation as a negative control: both
    // live clones then own different byte allocations.
    assert_eq!(original.image.as_ref().unwrap().as_ptr(),derived.image.as_ref().unwrap().as_ptr());
    assert_eq!(serde_json::to_vec(&derived).unwrap(),before);
    derived.image=Some("data:image/png;base64,AQID".into());
    assert_eq!(serde_json::to_vec(&original).unwrap(),before);
    assert_ne!(derived,original);
    let restored:Paint=serde_json::from_slice(&before).unwrap();
    assert_eq!(serde_json::to_vec(&restored).unwrap(),before);
    assert_eq!(restored,original);
}
