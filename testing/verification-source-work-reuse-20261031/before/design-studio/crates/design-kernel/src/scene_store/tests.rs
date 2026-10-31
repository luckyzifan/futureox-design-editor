use super::*;
use serde_json::json;

struct Fixture {
    directory: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "futureox-scene-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("scene.fsc");
        Self { directory, path }
    }
    fn write(&self, doc: &Document) -> Descriptor {
        write(
            &self.path,
            "source:revision:7",
            doc,
            &["preserved warning".into()],
            &AtomicBool::new(false),
        )
        .unwrap()
    }
    fn files(&self) -> usize {
        fs::read_dir(&self.directory).unwrap().count()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn document(count: usize) -> Document {
    let nodes=(0..count).map(|i|{let id=format!("node-{i:05}");(id.clone(),json!({"id":id,"kind":"rectangle","width":10.25,"height":20.5,
        "transform":[1.,0.,-0.,1.,i as f64*32.,-0.],"name":format!("节点 {i}"),"fills":[{"kind":"solid","color":"#abcdef"}],
        "bindings":{"opaque":"{\"keep\":1e+02,\"signed\":-0.0}"}}))}).collect::<serde_json::Map<_,_>>();
    serde_json::from_value(json!({"schemaVersion":20,"id":"source-doc","name":"拓扑模块测试","pages":[{"id":"p","name":"page","children":nodes.keys().cloned().collect::<Vec<_>>(),"background":"#ffffff"}],"nodes":nodes,
        "fdCompatibility":{"contractVersion":1,"requiredCapabilities":[],"extensions":{"com.example/test":{"number":1.25,"keep":null}}}})).unwrap()
}
fn modify(path: &Path, at: u64, bytes: &[u8]) {
    let mut file = OpenOptions::new().write(true).open(path).unwrap();
    file.seek(SeekFrom::Start(at)).unwrap();
    file.write_all(bytes).unwrap();
    file.flush().unwrap();
}

#[test]
fn complete_roundtrip_preserves_metadata_order_and_float_bits_after_reopen() {
    let fixture = Fixture::new();
    let doc = document(11);
    let receipt = fixture.write(&doc);
    let cancel = AtomicBool::new(false);
    assert_eq!(fixture.files(), 1);
    {
        let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
        assert_eq!(reader.node_count(), 11);
        assert_eq!(reader.stats(), ReadStats::default());
        assert!(reader.metadata(&cancel).unwrap().nodes.is_empty());
        assert_eq!(reader.stats().metadata_reads, 1);
        assert_eq!(reader.stats().node_reads, 0);
    }
    assert!(fixture.path.exists());
    let (actual, warnings) = Reader::open(&fixture.path, &receipt, &cancel)
        .unwrap()
        .into_document(&cancel)
        .unwrap();
    assert_eq!(actual, doc);
    assert_eq!(warnings, vec!["preserved warning"]);
    assert_eq!(
        serde_json::to_vec(&actual).unwrap(),
        serde_json::to_vec(&doc).unwrap()
    );
    assert_eq!(
        actual.nodes["node-00003"].transform.0[5].to_bits(),
        (-0_f64).to_bits()
    );
}

#[test]
fn one_node_out_of_ten_thousand_reads_only_its_payload_and_logarithmic_index_paths() {
    let fixture = Fixture::new();
    let doc = document(10_001);
    let receipt = fixture.write(&doc);
    let cancel = AtomicBool::new(false);
    let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
    assert_eq!(reader.stats().node_reads, 0);
    let node = reader.read_node("node-07891", &cancel).unwrap().unwrap();
    assert_eq!(node, doc.nodes["node-07891"]);
    let stats = reader.stats();
    assert_eq!(stats.node_reads, 1);
    assert!(stats.key_reads <= 14);
    assert!(stats.index_bytes_verified < 10_000);
    assert_eq!(
        stats.node_bytes,
        serde_json::to_vec(&NodeRecordRef{node:Cow::Borrowed(&node),images:vec![],geometry:None,vectors:None}).unwrap().len() as u64
    );
    assert!(reader.read_node("missing", &cancel).unwrap().is_none());
    assert_eq!(reader.stats().node_reads, 1);
}

#[test]
fn cold_corrupt_payload_does_not_get_read_for_an_unrelated_node() {
    let fixture = Fixture::new();
    let doc = document(8);
    let receipt = fixture.write(&doc);
    let cancel = AtomicBool::new(false);
    let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
    let cold = reader.row(7, &cancel).unwrap();
    modify(&fixture.path, cold.value_offset, b"!");
    assert_eq!(
        reader.read_node("node-00000", &cancel).unwrap().unwrap(),
        doc.nodes["node-00000"]
    );
    assert!(reader.read_node("node-00007", &cancel).is_err());
    assert!(
        Reader::open(&fixture.path, &receipt, &cancel)
            .unwrap()
            .into_document(&cancel)
            .is_err()
    );
}

#[test]
fn a_changed_index_after_open_cannot_redirect_a_node_read() {
    let fixture = Fixture::new();
    let receipt = fixture.write(&document(7));
    let cancel = AtomicBool::new(false);
    let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
    modify(
        &fixture.path,
        reader.index_offset + 3 * ROW_BYTES + 16,
        &0_u64.to_le_bytes(),
    );
    let error = reader.read_node("node-00003", &cancel).unwrap_err();
    assert!(error.to_string().contains("index changed"));
    assert!(
        Reader::open(&fixture.path, &receipt, &cancel)
            .unwrap()
            .into_document(&cancel)
            .is_err()
    );
}

#[test]
fn changed_proof_or_key_never_uses_unauthenticated_nodes() {
    for proof in [false, true] {
        let fixture = Fixture::new();
        let receipt = fixture.write(&document(8));
        let cancel = AtomicBool::new(false);
        let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
        let row = reader.row(3, &cancel).unwrap();
        let at = if proof {
            reader.tree_offset + 9 * 32
        } else {
            row.key_offset
        };
        let mut file = File::open(&fixture.path).unwrap();
        file.seek(SeekFrom::Start(at)).unwrap();
        let mut byte = [0];
        file.read_exact(&mut byte).unwrap();
        byte[0] ^= 0x20;
        modify(&fixture.path, at, &byte);
        assert!(
            reader.read_node("node-00003", &cancel).is_err(),
            "proof={proof}"
        );
        assert_eq!(reader.stats().node_reads, 0);
    }
}

#[test]
fn descriptor_generation_document_count_footer_and_file_size_are_fenced() {
    let fixture = Fixture::new();
    let receipt = fixture.write(&document(3));
    let cancel = AtomicBool::new(false);
    for kind in 0..5 {
        let mut wrong = receipt.clone();
        match kind {
            0 => wrong.generation.push('x'),
            1 => wrong.document_id.push('x'),
            2 => wrong.nodes += 1,
            3 => wrong.footer_hash[0] ^= 1,
            _ => wrong.bytes -= 1,
        };
        assert!(Reader::open(&fixture.path, &wrong, &cancel).is_err());
    }
    modify(&fixture.path, receipt.bytes - 1, b"x");
    assert!(Reader::open(&fixture.path, &receipt, &cancel).is_err());
}

#[test]
fn failure_and_cancellation_do_not_publish_or_overwrite_a_store() {
    let fixture = Fixture::new();
    let mut doc = document(2);
    let cancel = AtomicBool::new(true);
    assert!(write(&fixture.path, "g", &doc, &[], &cancel).is_err());
    assert_eq!(fixture.files(), 0);
    cancel.store(false, Ordering::Release);
    doc.nodes.get_mut("node-00001").unwrap().id = "wrong-id".into();
    assert!(write(&fixture.path, "g", &doc, &[], &cancel).is_err());
    assert_eq!(fixture.files(), 0);
    let receipt = fixture.write(&document(2));
    let before = fs::read(&fixture.path).unwrap();
    assert!(write(&fixture.path, "other", &document(1), &[], &cancel).is_err());
    assert_eq!(fs::read(&fixture.path).unwrap(), before);
    let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
    cancel.store(true, Ordering::Release);
    assert!(
        reader
            .read_node("node-00000", &cancel)
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
    assert_eq!(reader.stats().node_reads, 0);
    assert!(Reader::open(&fixture.path, &receipt, &cancel).is_err());
    assert_eq!(fixture.files(), 1);
}

#[test]
fn empty_single_and_non_power_of_two_stores_share_the_same_reader_contract() {
    for count in [0, 1, 2, 3, 5, 9, 17, 65] {
        let fixture = Fixture::new();
        let doc = document(count);
        let receipt = fixture.write(&doc);
        let cancel = AtomicBool::new(false);
        let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
        for (id, node) in &doc.nodes {
            assert_eq!(reader.read_node(id, &cancel).unwrap().as_ref(), Some(node));
        }
        assert_eq!(reader.into_document(&cancel).unwrap().0, doc);
    }
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_replace_owned_store_files() {
    let fixture = Fixture::new();
    let receipt = fixture.write(&document(1));
    let link = fixture.directory.join("link");
    std::os::unix::fs::symlink(&fixture.path, &link).unwrap();
    assert!(Reader::open(&link, &receipt, &AtomicBool::new(false)).is_err());
}

#[test]
#[ignore = "explicit full topology source-model module regression; no GUI or GPU"]
fn full_topology_model_supports_random_reads_and_complete_semantic_roundtrip() {
    let source =
        std::env::var("FUTUREOX_TOPOLOGY_MODEL").expect("explicit topology snapshot path required");
    let expected =
        std::env::var("FUTUREOX_TOPOLOGY_MODEL_SHA256").expect("frozen source hash required");
    let cancel = AtomicBool::new(false);
    let started = std::time::Instant::now();
    let mut input = HashReader {
        inner: File::open(source).unwrap(),
        bytes: 0,
        hash: Sha256::new(),
        cancel: &cancel,
    };
    let document: Document = serde_json::from_reader(BufReader::new(&mut input)).unwrap();
    let source_hash = format!("{:x}", input.hash.finalize());
    assert_eq!(source_hash, expected);
    assert_eq!(document.nodes.len(), 124447);
    let stage = &document.nodes[&document.pages[0].children[0]];
    assert_eq!(stage.children.len(), 306);
    let fixture = Fixture::new();
    let receipt = fixture.write(&document);
    let mut reader = Reader::open(&fixture.path, &receipt, &cancel).unwrap();
    assert_eq!(reader.stats().node_reads, 0);
    let selected = document.nodes.iter().step_by(9973).collect::<Vec<_>>();
    for (id, node) in &selected {
        assert_eq!(reader.read_node(id, &cancel).unwrap().as_ref(), Some(*node));
    }
    let reads = reader.stats();
    assert_eq!(reads.node_reads, selected.len() as u64);
    assert!(reads.key_reads <= 18 * reads.node_reads);
    assert!(reads.index_bytes_verified < 16_000 * reads.node_reads);
    assert_eq!(reads.metadata_reads, 0);
    drop(selected);
    drop(document);
    let (restored, warnings) = reader.into_document(&cancel).unwrap();
    assert_eq!(warnings, vec!["preserved warning"]);
    let rewritten = write(
        &fixture.directory.join("roundtrip.fsc"),
        &receipt.generation,
        &restored,
        &warnings,
        &cancel,
    )
    .unwrap();
    // The footer binds metadata and every exact key/payload hash through the
    // index root. Re-serialization must preserve the complete content receipt.
    assert_eq!(rewritten, receipt);
    println!(
        "{}",
        json!({"scope":"full topology native storage module, no GUI/GPU or latency acceptance", "sourceHash":source_hash,
        "sourceBytes":input.bytes,"nodes":receipt.nodes,"roots":306,"storeBytes":receipt.bytes,"randomNodesRead":reads.node_reads,
        "randomNodeBytes":reads.node_bytes,"metadataBytesDuringRandomReads":reads.metadata_bytes,"openFooterBytes":FOOTER_BYTES+8,"randomIndexProofBytes":reads.index_bytes_verified,"semanticRoundtripEqual":true,"seconds":started.elapsed().as_secs_f64()})
    );
}

#[test]
fn dense_node_demand_streams_once_without_loading_metadata() {
    let fixture = Fixture::new();
    let doc = document(1001);
    let descriptor = fixture.write(&doc);
    let cancel = AtomicBool::new(false);
    let mut reader = Reader::open(&fixture.path, &descriptor, &cancel).unwrap();
    assert_eq!(reader.read_all_nodes(&cancel).unwrap(), doc.nodes);
    let stats = reader.stats();
    assert_eq!(stats.metadata_reads, 0);
    assert_eq!(stats.node_reads, 1001);
    assert_eq!(stats.key_reads, 1001);
    assert_eq!(stats.index_bytes_verified, 1001 * ROW_BYTES);
    assert_eq!(reader.metadata(&cancel).unwrap().id, doc.id);
    let row = reader.row(1000, &cancel).unwrap();
    modify(&fixture.path, row.value_offset, b"!");
    assert!(reader.read_all_nodes(&cancel).is_err());
}


#[test]
fn shared_images_are_authenticated_lazy_and_restore_original_arcs_and_bytes() {
    let fixture=Fixture::new();let mut doc=document(3);
    let image:Arc<str>=format!("data:image/png;base64,{}","a".repeat(1024*1024)).into();
    for node in doc.nodes.values_mut(){node.fills[0].image=Some(image.clone());}
    let receipt=fixture.write(&doc);assert!(receipt.bytes<2*1024*1024);
    let cancel=AtomicBool::new(false);
    let mut reader=Reader::open(&fixture.path,&receipt,&cancel).unwrap();
    let last=reader.read_node("node-00002",&cancel).unwrap().unwrap();
    assert_eq!(last,doc.nodes["node-00002"]);
    assert_eq!(reader.stats().metadata_reads,0);
    assert_eq!(reader.stats().node_reads,2,"requested node and its one image owner, no middle node");
    let first=reader.read_node("node-00000",&cancel).unwrap().unwrap();
    assert_eq!(first,doc.nodes["node-00000"]);
    let (restored,_)=Reader::open(&fixture.path,&receipt,&cancel).unwrap().into_document(&cancel).unwrap();
    assert_eq!(serde_json::to_vec(&restored).unwrap(),serde_json::to_vec(&doc).unwrap());
    assert!(Arc::ptr_eq(restored.nodes["node-00000"].fills[0].image.as_ref().unwrap(),restored.nodes["node-00002"].fills[0].image.as_ref().unwrap()));
    // An unrelated cold node may be corrupt without being read for the last
    // node's image. Corrupting that actual image owner must reject the read.
    let row=reader.find_row("node-00001",&cancel).unwrap().unwrap();modify(&fixture.path,row.value_offset,b"!");
    assert!(Reader::open(&fixture.path,&receipt,&cancel).unwrap().read_node("node-00002",&cancel).unwrap().is_some());
    let row=reader.find_row("node-00000",&cancel).unwrap().unwrap();modify(&fixture.path,row.value_offset,b"!");
    assert!(Reader::open(&fixture.path,&receipt,&cancel).unwrap().read_node("node-00002",&cancel).is_err());
}
#[test]
fn legacy_scene_format_still_reads_without_shared_image_envelopes() {
    let fixture=Fixture::new();let doc=document(5);let cancel=AtomicBool::new(false);
    let receipt=write_format(&fixture.path,"source:revision:7",&doc,&[],&cancel,false).unwrap();
    let (restored,_)=Reader::open(&fixture.path,&receipt,&cancel).unwrap().into_document(&cancel).unwrap();
    assert_eq!(doc,restored);
}
#[test]
fn shared_image_references_cannot_override_inline_paints_or_form_cycles() {
    let doc=document(1);let node=doc.nodes["node-00000"].clone();let slot=ImageSlot{stroke:false,index:0};
    for source in ["node-00000","node-99999"] {
        assert!(restore_record(NodeRecord{node:node.clone(),geometry:None,vectors:None,images:vec![ImageReference{slot:slot.clone(),source:ImageAddress{node:source.into(),slot:slot.clone()}}]},&mut HashMap::new(),&mut HashMap::new()).is_err());
    }
    let mut node=node;node.id="z".into();node.fills[0].image=Some("inline".into());
    let address=ImageAddress{node:"a".into(),slot:slot.clone()};let mut images=HashMap::from([(address.clone(),Arc::<str>::from("foreign"))]);
    assert!(restore_record(NodeRecord{node,geometry:None,vectors:None,images:vec![ImageReference{slot,source:address}]},&mut images,&mut HashMap::new()).is_err());
}

#[test]
fn shared_vector_records_restore_exact_values_and_mutations_do_not_change_siblings(){
    let fixture=Fixture::new();let mut doc=document(3);
    let geometry:Arc<VectorGeometry>=Arc::new(serde_json::from_value(json!({"fillRule":"nonzero","fill":[{"move":[-0.,0.]},{"line":[10.,0.]},{"line":[10.,10.]},"close"]})).unwrap());
    for node in doc.nodes.values_mut(){node.kind="vector".into();node.vector_geometry=Some(geometry.clone());}
    let receipt=fixture.write(&doc);let cancel=AtomicBool::new(false);
    let mut reader=Reader::open(&fixture.path,&receipt,&cancel).unwrap();
    let selected=reader.read_node("node-00002",&cancel).unwrap().unwrap();assert_eq!(selected,doc.nodes["node-00002"]);
    assert_eq!(reader.stats().node_reads,2);assert_eq!(reader.stats().metadata_reads,0);
    let (mut restored,_)=Reader::open(&fixture.path,&receipt,&cancel).unwrap().into_document(&cancel).unwrap();
    assert_eq!(serde_json::to_vec(&restored).unwrap(),serde_json::to_vec(&doc).unwrap());
    assert!(Arc::ptr_eq(restored.nodes["node-00000"].vector_geometry.as_ref().unwrap(),restored.nodes["node-00002"].vector_geometry.as_ref().unwrap()));
    Arc::make_mut(restored.nodes.get_mut("node-00002").unwrap().vector_geometry.as_mut().unwrap()).scale(2.,3.);
    assert_eq!(restored.nodes["node-00000"],doc.nodes["node-00000"]);assert_ne!(restored.nodes["node-00002"],doc.nodes["node-00002"]);
    let row=reader.find_row("node-00000",&cancel).unwrap().unwrap();modify(&fixture.path,row.value_offset,b"!");
    assert!(Reader::open(&fixture.path,&receipt,&cancel).unwrap().read_node("node-00002",&cancel).is_err());
}
#[test]
fn version_two_image_envelopes_remain_readable(){
    let fixture=Fixture::new();let doc=document(2);let mut receipt=fixture.write(&doc);let cancel=AtomicBool::new(false);
    modify(&fixture.path,0,IMAGE_MAGIC);modify(&fixture.path,receipt.bytes-8,IMAGE_MAGIC);
    let mut file=File::open(&fixture.path).unwrap();file.seek(SeekFrom::Start(receipt.bytes-FOOTER_BYTES)).unwrap();let mut footer=[0u8;FOOTER_BYTES as usize];file.read_exact(&mut footer).unwrap();receipt.footer_hash=sha(&footer);
    let (restored,_)=Reader::open(&fixture.path,&receipt,&cancel).unwrap().into_document(&cancel).unwrap();assert_eq!(restored,doc);
}
