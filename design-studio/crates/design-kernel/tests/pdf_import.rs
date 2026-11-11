//! Integration tests for the vector PDF importer. Every fixture is built
//! in-test: minimal classic-xref PDFs plus a stored-block zlib encoder, so
//! the tests never depend on external files or the export side.
use futureox_design_kernel::pdf_import::{import_pdf, import_pdf_report, is_pdf_file};
use futureox_design_kernel::scene::{Document, Node};
use std::collections::BTreeMap;

mod pdf_import {
    use super::*;

    // ---------------------------------------------------------------------------
    // fixture helpers
    // ---------------------------------------------------------------------------

    /// zlib stream with stored (uncompressed) deflate blocks — valid
    /// FlateDecode data without any deflate implementation.
    fn zlib_stored(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x78, 0x01];
        if data.is_empty() {
            out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
        } else {
            let mut chunks = data.chunks(65535).peekable();
            while let Some(chunk) = chunks.next() {
                out.push(if chunks.peek().is_none() { 1 } else { 0 });
                let length = chunk.len() as u16;
                out.extend_from_slice(&length.to_le_bytes());
                out.extend_from_slice(&(!length).to_le_bytes());
                out.extend_from_slice(chunk);
            }
        }
        // Adler-32 trailer.
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in data {
            a = (a + u32::from(byte)) % 65521;
            b = (b + a) % 65521;
        }
        out.extend_from_slice(&((b << 16) | a).to_be_bytes());
        out
    }

    /// Assemble a classic-xref single- (or multi-) page PDF from object bodies.
    fn build_pdf(objects: &[(u32, Vec<u8>)], root: u32) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = BTreeMap::new();
        let mut max = root;
        for (num, body) in objects {
            max = max.max(*num);
            offsets.insert(*num, out.len());
            out.extend_from_slice(format!("{num} 0 obj\n").as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", max + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for num in 1..=max {
            match offsets.get(&num) {
                Some(off) => out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes()),
                None => out.extend_from_slice(b"0000000000 00000 f \n"),
            }
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {root} 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                max + 1
            )
            .as_bytes(),
        );
        out
    }

    /// Stream objects hold binary payloads (zlib, pixels) — build as raw bytes.
    fn stream_object(dict: &str, data: &[u8]) -> Vec<u8> {
        let mut body = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\nendstream");
        body
    }

    fn text_object(text: &str) -> Vec<u8> {
        text.as_bytes().to_vec()
    }

    fn content_stream(content: &str) -> Vec<u8> {
        stream_object("", content.as_bytes())
    }

    fn flate_content_stream(content: &str) -> Vec<u8> {
        stream_object("/Filter /FlateDecode", &zlib_stored(content.as_bytes()))
    }

    /// One-page PDF (MediaBox 0 0 612 792) with the given content and resources.
    fn single_page(content: &str, resources: &str, flate: bool) -> Vec<u8> {
        let contents = if flate {
            flate_content_stream(content)
        } else {
            content_stream(content)
        };
        let objects = vec![
            (1, text_object("<< /Type /Catalog /Pages 2 0 R >>")),
            (2, text_object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")),
            (
                3,
                text_object(&format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << {resources} >> >>"
                )),
            ),
            (4, contents),
        ];
        build_pdf(&objects, 1)
    }

    fn page_children(doc: &Document) -> &[String] {
        let page = &doc.pages[0];
        assert_eq!(page.children.len(), 1);
        let frame = &doc.nodes[&page.children[0]];
        assert_eq!(frame.kind, "frame");
        assert!(frame.clip);
        &frame.children
    }

    fn only_node(doc: &Document) -> &Node {
        let children = page_children(doc);
        assert_eq!(children.len(), 1, "expected one imported node");
        &doc.nodes[&children[0]]
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "got {actual}, want {expected}"
        );
    }

    fn assert_transform(node: &Node, expected: [f64; 6]) {
        for (actual, want) in node.transform.0.iter().zip(expected) {
            assert_close(*actual, want);
        }
    }

    // ---------------------------------------------------------------------------
    // tests
    // ---------------------------------------------------------------------------

    #[test]
    fn detects_header_within_first_kilobyte() {
        assert!(is_pdf_file(b"%PDF-1.7\nrest"));
        let mut padded = vec![b'x'; 500];
        padded.extend_from_slice(b"%PDF-1.4\n");
        assert!(is_pdf_file(&padded));
        assert!(!is_pdf_file(b"%PD-1.4"));
        assert!(!is_pdf_file(b""));
        assert!(!is_pdf_file(b"plain text file"));
        let mut far = vec![b'x'; 1100];
        far.extend_from_slice(b"%PDF-1.4\n");
        assert!(!is_pdf_file(&far));
    }

    #[test]
    fn rectangle_fill_maps_with_y_flip_and_color() {
        let bytes = single_page("0 0 1 rg 100 200 50 40 re f", "", false);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        assert_eq!(doc.id, "imported-pdf");
        assert_eq!(doc.name, "Imported from PDF 1.4");
        let node = only_node(&doc);
        assert_eq!(node.kind, "vector");
        // Design page space is y-down: the PDF rect (100,200)-(150,240) maps to
        // a node at x=100 whose transform carries the vertical flip (d = -1) and
        // the y position of the PDF bottom edge: 792 - 200 = 592.
        assert_transform(node, [1., 0., 0., -1., 100., 592.]);
        assert_close(node.width, 50.);
        assert_close(node.height, 40.);
        assert_eq!(node.fills.len(), 1);
        assert_eq!(node.fills[0].kind, "solid");
        assert_eq!(node.fills[0].color, "#0000ff");
        assert!(node.strokes.is_empty());
        assert_eq!(node.network.as_ref().unwrap().fill_rule, "nonzero");
        let network = node.network.as_ref().unwrap();
        let expected = [(0., 0.), (50., 0.), (50., 40.), (0., 40.)];
        for (vertex, want) in network.vertices.iter().zip(expected) {
            assert_close(vertex.x, want.0);
            assert_close(vertex.y, want.1);
        }
        // Three rectangle edges plus the implicit closing edge.
        assert_eq!(network.edges.len(), 4);
        assert!(
            network
                .edges
                .iter()
                .all(|e| e.c1.is_none() && e.c2.is_none())
        );
        assert_close(node.opacity, 1.);
    }

    #[test]
    fn cm_transform_lands_on_node_transform() {
        let bytes = single_page("q 2 0 0 2 10 20 cm 1 0 0 rg 0 0 50 40 re f Q", "", false);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let node = only_node(&doc);
        // Local path units stay untransformed; the CTM lands in the transform:
        // scale 2 with the page flip on y: [2, 0, 0, -2, 10, 792 - 20].
        assert_transform(node, [2., 0., 0., -2., 10., 772.]);
        assert_close(node.width, 50.);
        assert_close(node.height, 40.);
        assert_eq!(node.fills[0].color, "#ff0000");
    }

    #[test]
    fn flate_content_stream_roundtrips() {
        let bytes = single_page("0 1 0 rg 100 200 50 40 re f", "", true);
        assert!(bytes.windows(12).any(|w| w == b"/FlateDecode"));
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let node = only_node(&doc);
        assert_eq!(node.fills[0].color, "#00ff00");
        assert_transform(node, [1., 0., 0., -1., 100., 592.]);
    }

    #[test]
    fn text_operators_are_safely_skipped() {
        let bytes = single_page(
            "BT /F1 12 Tf 72 720 Td [(H) 120 (i)] TJ (x) Tj 0 0 1 rg 10 20 30 40 re f ET 5 5 Td (lost) Tj",
            "/Font << /F1 9 0 R >>",
            false,
        );
        let report = import_pdf_report(&bytes).unwrap();
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("文字未转换"))
        );
        let doc = report.document;
        doc.validate().unwrap();
        let children = page_children(&doc);
        assert_eq!(children.len(), 1);
        assert!(doc.nodes.values().all(|n| n.kind != "text"));
        assert!(doc.nodes.values().all(|n| n.text.is_empty()));
    }

    #[test]
    fn curve_operators_map_to_network_control_points() {
        // m, c, v (reflected first control), y (second control = endpoint), h.
        let bytes = single_page(
            "10 10 m 20 10 30 40 40 40 c 55 45 70 30 v 65 20 80 25 y h f",
            "",
            false,
        );
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let node = only_node(&doc);
        let network = node.network.as_ref().unwrap();
        // Local origin is the bbox minimum (10,10), max (80,45).
        assert_close(node.width, 70.);
        assert_close(node.height, 35.);
        assert_eq!(network.vertices.len(), 4);
        assert_eq!(network.edges.len(), 4); // three curves plus the close edge
        let edge = &network.edges[0];
        let (c1, c2) = (edge.c1.unwrap(), edge.c2.unwrap());
        assert_close(c1.x, 10.);
        assert_close(c1.y, 0.);
        assert_close(c2.x, 20.);
        assert_close(c2.y, 30.);
        // v reflects the previous c2 (30,40) around the pen (40,40) → (50,40).
        let edge = &network.edges[1];
        let (c1, c2) = (edge.c1.unwrap(), edge.c2.unwrap());
        assert_close(c1.x, 40.);
        assert_close(c1.y, 30.);
        assert_close(c2.x, 45.);
        assert_close(c2.y, 35.);
        // y uses the endpoint as its second control.
        let edge = &network.edges[2];
        let (c1, c2) = (edge.c1.unwrap(), edge.c2.unwrap());
        assert_close(c1.x, 55.);
        assert_close(c1.y, 10.);
        assert_close(c2.x, 70.);
        assert_close(c2.y, 15.);
    }

    #[test]
    fn stroke_uses_line_width_and_current_stroke_color() {
        let bytes = single_page("1 0 0 RG 2 w 0 0 60 20 re S", "", false);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let node = only_node(&doc);
        assert!(node.fills.is_empty());
        assert_eq!(node.strokes.len(), 1);
        assert_close(node.strokes[0].width, 2.);
        assert_eq!(node.strokes[0].paint.color, "#ff0000");
    }

    #[test]
    fn push_pop_restores_graphics_state() {
        let bytes = single_page("q 1 0 0 rg Q 0 0 1 rg 0 0 10 10 re f", "", false);
        let doc = import_pdf(&bytes).unwrap();
        let node = only_node(&doc);
        assert_eq!(node.fills[0].color, "#0000ff");
    }

    #[test]
    fn evenodd_and_multi_subpath_single_node() {
        let bytes = single_page("0 0 10 10 re 20 20 5 5 re f*", "", false);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let node = only_node(&doc);
        let network = node.network.as_ref().unwrap();
        assert_eq!(network.vertices.len(), 8);
        assert_eq!(network.edges.len(), 8);
        assert_eq!(network.fill_rule, "evenodd");
        // Default (unset) fill color is black.
        assert_eq!(node.fills[0].color, "#000000");
    }

    #[test]
    fn filled_cubic_ring_closes_at_its_existing_start_vertex() {
        use futureox_design_kernel::path::Command;
        let bytes = single_page(
            "0.1 0.2 0.8 rg 90 50 m \
             90 63.80712 78.80712 75 65 75 c 51.19288 75 40 63.80712 40 50 c \
             40 36.19288 51.19288 25 65 25 c 78.80712 25 90 36.19288 90 50 c f*",
            "",
            false,
        );
        let doc = import_pdf(&bytes).unwrap();
        let node = only_node(&doc);
        let network = node.network.as_ref().unwrap();
        assert_eq!((network.vertices.len(), network.edges.len()), (4, 4));
        assert_eq!(network.edges[3].to, network.edges[0].from);
        let (fill, _) = node.paths().unwrap();
        assert_eq!(
            fill.commands
                .iter()
                .filter(|c| matches!(c, Command::Cubic(..)))
                .count(),
            4
        );
        assert_eq!(fill.commands.last(), Some(&Command::Close));
    }

    #[test]
    fn extgstate_ca_and_ca_map_into_opacity() {
        let content = "q /Half gs 0 0 10 10 re f Q /Both gs 0 20 10 10 re B";
        let objects = vec![
            (1, text_object("<< /Type /Catalog /Pages 2 0 R >>")),
            (2, text_object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")),
            (
                3,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /ExtGState << /Half 7 0 R /Both 8 0 R >> >> >>",
                ),
            ),
            (4, content_stream(content)),
            (7, text_object("<< /Type /ExtGState /ca 0.5 >>")),
            (8, text_object("<< /Type /ExtGState /ca 0.5 /CA 0.25 >>")),
        ];
        let bytes = build_pdf(&objects, 1);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let children = page_children(&doc);
        assert_eq!(children.len(), 2);
        let fill_only = &doc.nodes[&children[0]];
        assert_close(fill_only.opacity, 0.5);
        assert_close(fill_only.fills[0].opacity, 1.);
        let fill_and_stroke = &doc.nodes[&children[1]];
        // min(ca, CA) lands on the node; the stroke keeps its exact share.
        assert_close(fill_and_stroke.opacity, 0.25);
        assert_close(fill_and_stroke.fills[0].opacity, 1.);
        assert_close(fill_and_stroke.strokes[0].paint.opacity, 1.);
    }

    #[test]
    fn multiple_pages_each_become_a_design_page() {
        let objects = vec![
            (1, text_object("<< /Type /Catalog /Pages 2 0 R >>")),
            (
                2,
                text_object("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"),
            ),
            (
                3,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << >> >>",
                ),
            ),
            (4, content_stream("0 0 1 rg 0 0 30 30 re f")),
            (
                5,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 6 0 R /Resources << >> >>",
                ),
            ),
            (6, content_stream("10 20 30 40 re f")),
        ];
        let bytes = build_pdf(&objects, 1);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        assert_eq!(doc.pages.len(), 2);
        assert_eq!(doc.pages[0].name, "Page 1");
        assert_eq!(doc.pages[1].name, "Page 2");
        let first_frame = &doc.nodes[&doc.pages[0].children[0]];
        assert_eq!((first_frame.width, first_frame.height), (300., 400.));
        let first = &doc.nodes[&first_frame.children[0]];
        assert_eq!(first.fills[0].color, "#0000ff");
        // Second page: height 100 → y flip puts user y=20 at 100 - 20 = 80.
        let second_frame = &doc.nodes[&doc.pages[1].children[0]];
        assert_eq!((second_frame.width, second_frame.height), (200., 100.));
        let second = &doc.nodes[&second_frame.children[0]];
        assert_transform(second, [1., 0., 0., -1., 10., 80.]);
        assert_close(second.width, 30.);
        assert_close(second.height, 40.);
    }

    #[test]
    fn text_and_rotated_crop_keep_the_page_and_baseline() {
        let objects = vec![
            (1, text_object("<< /Type /Catalog /Pages 2 0 R >>")),
            (
                2,
                text_object(
                    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [10 15 170 135] /CropBox [20 25 150 115] /Rotate 90 >>",
                ),
            ),
            (
                3,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
                ),
            ),
            (
                4,
                content_stream(
                    "BT /F1 12 Tf 1 0 0 1 30 90 Tm (PAGE_A_TEXT) Tj ET 1 0 0 rg 20 25 20 40 re f",
                ),
            ),
            (
                5,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /CropBox [10 15 170 135] /Rotate 0 /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
                ),
            ),
            (
                6,
                content_stream("BT /F1 12 Tf 30 90 Td (PAGE_B_TEXT) Tj ET"),
            ),
            (
                7,
                text_object(
                    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
                ),
            ),
        ];
        let report = import_pdf_report(&build_pdf(&objects, 1)).unwrap();
        let doc = &report.document;
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("替代字体"));
        let frame = &doc.nodes[&doc.pages[0].children[0]];
        assert_eq!((frame.width, frame.height), (90., 130.));
        assert!(frame.clip);
        let text = &doc.nodes[&frame.children[0]];
        assert_eq!(text.kind, "text");
        assert_eq!(text.text, "PAGE_A_TEXT");
        let layout = futureox_design_kernel::font::Fonts::new()
            .with_resources(&doc.fonts)
            .unwrap()
            .node_measure(text, None)
            .unwrap();
        let baseline = text
            .transform
            .point(futureox_design_kernel::math::Point::new(
                0.,
                layout.glyphs[0].y,
            ));
        assert_close(baseline.x, 65.);
        assert_close(baseline.y, 10.);
        let path = &doc.nodes[&frame.children[1]];
        assert_transform(path, [0., 1., 1., 0., 0., 0.]);
        let meta = &doc.design_system.as_ref().unwrap().sketch_containers["nodeMetadata"]
            [&frame.id]["bindings"]["pdfPageBoxes"];
        let boxes: serde_json::Value = serde_json::from_str(meta.as_str().unwrap()).unwrap();
        assert_eq!(boxes["rotate"], 90);
        assert_eq!(boxes["mediaBox"], serde_json::json!([10., 15., 170., 135.]));
        assert_eq!(boxes["cropBox"], serde_json::json!([20., 25., 150., 115.]));
        let second = &doc.nodes[&doc.pages[1].children[0]];
        assert_eq!((second.width, second.height), (160., 120.));
        assert_eq!(doc.nodes[&second.children[0]].text, "PAGE_B_TEXT");
    }

    #[test]
    fn image_xobjects_become_image_nodes() {
        let rgb = [255u8, 0, 0, 0, 255, 0];
        let objects = vec![
            (1, text_object("<< /Type /Catalog /Pages 2 0 R >>")),
            (2, text_object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")),
            (
                3,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R /J0 6 0 R >> >> >>",
                ),
            ),
            (
                4,
                content_stream("q 100 0 0 50 10 20 cm /Im0 Do Q q 60 0 0 30 200 100 cm /J0 Do Q"),
            ),
            (
                5,
                stream_object(
                    "/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
                    &zlib_stored(&rgb),
                ),
            ),
            (
                6,
                stream_object(
                    "/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
                    &[0xff, 0xd8, 0xff, 0xe0, 1, 2],
                ),
            ),
        ];
        let bytes = build_pdf(&objects, 1);
        let doc = import_pdf(&bytes).unwrap();
        doc.validate().unwrap();
        let children = page_children(&doc);
        assert_eq!(children.len(), 2);
        let flate_node = &doc.nodes[&children[0]];
        assert_eq!(flate_node.kind, "rectangle");
        assert_close(flate_node.width, 100.);
        assert_close(flate_node.height, 50.);
        // Unit square under cm (100x50 at 10,20) → design y 792-20-50 = 722.
        assert_transform(flate_node, [1., 0., 0., 1., 10., 722.]);
        let paint = &flate_node.fills[0];
        assert_eq!(paint.kind, "image");
        assert_eq!(paint.fit, "stretch");
        assert!(
            paint
                .image
                .as_deref()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        let jpeg_node = &doc.nodes[&children[1]];
        assert_eq!(jpeg_node.kind, "rectangle");
        assert!(
            jpeg_node.fills[0]
                .image
                .as_deref()
                .unwrap()
                .starts_with("data:image/jpeg;base64,")
        );
    }

    #[test]
    fn unsupported_image_filters_are_skipped_without_error() {
        let objects = vec![
            (1, text_object("<< /Type /Catalog /Pages 2 0 R >>")),
            (2, text_object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")),
            (
                3,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
                ),
            ),
            (
                4,
                content_stream("q 100 0 0 50 0 0 cm /Im0 Do Q 0 0 1 rg 1 1 8 8 re f"),
            ),
            (
                5,
                stream_object(
                    "/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /RunLengthDecode",
                    &[1, 2, 3],
                ),
            ),
        ];
        let bytes = build_pdf(&objects, 1);
        let doc = import_pdf(&bytes).unwrap();
        // Only the rectangle survives; the run-length image is skipped.
        let node = only_node(&doc);
        assert_eq!(node.kind, "vector");
    }

    #[test]
    fn corrupt_inputs_error_without_panicking() {
        assert!(import_pdf(b"%PDF-1.4\n").is_err());
        assert!(import_pdf(b"not a pdf at all").is_err());
        assert!(import_pdf(b"").is_err());
        // Valid header, broken startxref offset.
        let mut bad = single_page("0 0 1 rg 0 0 10 10 re f", "", false);
        let at = bad.windows(9).rposition(|w| w == b"startxref").unwrap() + 9;
        bad[at..at + 3].copy_from_slice(b"999");
        assert!(import_pdf(&bad).is_err());
        // Truncated file keeps its startxref but loses the xref table.
        let mut truncated = single_page("0 0 1 rg 0 0 10 10 re f", "", false);
        truncated.truncate(truncated.len() - 60);
        assert!(import_pdf(&truncated).is_err());
        // Broken flate data must error, not panic.
        let mut corrupted = single_page("0 0 1 rg 0 0 10 10 re f", "", true);
        let len = corrupted.len();
        corrupted[len - 30..len - 20].fill(0xff);
        assert!(import_pdf(&corrupted).is_err());
        // Random junk after a valid header.
        let mut junk = b"%PDF-1.4\n".to_vec();
        junk.extend(std::iter::repeat_n(0x5a, 512));
        assert!(import_pdf(&junk).is_err());
    }

    #[test]
    fn node_budget_is_enforced() {
        let mut content = String::new();
        for _ in 0..40_001 {
            content.push_str("0 0 1 1 re f ");
        }
        let bytes = single_page(&content, "", false);
        let error = import_pdf(&bytes).unwrap_err();
        assert!(error.contains("node budget"), "{error}");
    }

    #[test]
    fn path_command_budget_is_enforced() {
        let mut content = String::from("0 0 m ");
        for _ in 0..2_000_000 {
            content.push_str("1 1 l ");
        }
        let bytes = single_page(&content, "", false);
        let error = import_pdf(&bytes).unwrap_err();
        assert!(error.contains("path command budget"), "{error}");
    }

    #[test]
    fn xref_stream_and_object_stream_are_resolved() {
        // Object layout: 1 = ObjStm holding object 6 (catalog), 2 = pages,
        // 3 = page, 4 = content stream, 5 = xref stream (also covers itself).
        let header = b"6 0 ";
        let member = b"<< /Type /Catalog /Pages 2 0 R >>";
        let mut objstm_data = header.to_vec();
        objstm_data.extend_from_slice(member);
        let objstm = stream_object(
            &format!("/Type /ObjStm /N 1 /First {}", header.len()),
            &objstm_data,
        );
        let content = content_stream("0 1 0 rg 10 20 30 40 re f");

        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets: Vec<(u32, usize)> = Vec::new();
        let bodies = [
            (1u32, objstm),
            (2, text_object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")),
            (
                3,
                text_object(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>",
                ),
            ),
            (4, content),
        ];
        for (num, body) in &bodies {
            offsets.push((*num, out.len()));
            out.extend_from_slice(format!("{num} 0 obj\n").as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = out.len();
        // Xref stream rows: type (1B), offset (4B), generation (2B).
        let mut rows: Vec<u8> = Vec::new();
        rows.extend_from_slice(&[0, 0, 0, 0, 0, 0xff, 0xff]); // 0: free
        for (_, off) in &offsets {
            rows.push(1);
            rows.extend_from_slice(&(*off as u32).to_be_bytes());
            rows.extend_from_slice(&[0, 0]);
        }
        rows.push(1); // 5: the xref stream itself
        rows.extend_from_slice(&(xref_offset as u32).to_be_bytes());
        rows.extend_from_slice(&[0, 0]);
        rows.push(2); // 6: compressed in object stream 1, index 0
        rows.extend_from_slice(&1u32.to_be_bytes());
        rows.extend_from_slice(&0u16.to_be_bytes());
        let data = zlib_stored(&rows);
        out.extend_from_slice(format!("5 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Index [0 7] /Root 6 0 R /Filter /FlateDecode /Length {} >>\nstream\n", data.len()).as_bytes());
        out.extend_from_slice(&data);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        out.extend_from_slice(format!("startxref\n{xref_offset}\n%%EOF\n").as_bytes());

        let doc = import_pdf(&out).unwrap();
        doc.validate().unwrap();
        let node = only_node(&doc);
        assert_eq!(node.fills[0].color, "#00ff00");
        assert_transform(node, [1., 0., 0., -1., 10., 80.]);
    }

    #[test]
    fn interop_import_any_picks_up_the_pdf_branch() {
        let bytes = single_page("0 0 1 rg 100 200 50 40 re f", "", false);
        assert!(!futureox_design_kernel::interop::is_sketch_file(&bytes));
        let doc = futureox_design_kernel::interop::import_any(&bytes).unwrap();
        assert_eq!(doc.id, "imported-pdf");
        assert_eq!(page_children(&doc).len(), 1);
        // Non-pdf, non-zip bytes still report the sniff error.
        assert!(futureox_design_kernel::interop::import_any(b"junk").is_err());
    }
}
