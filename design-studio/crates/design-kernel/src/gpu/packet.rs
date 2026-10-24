//! Self-contained transport only. Images move outside JSON escaping/parsing;
//! shader geometry words, source strings, sample phases and policies do not change.
use super::{GpuScene, Paint};
use serde::Serialize;
use std::collections::HashMap;

impl GpuScene {
    pub fn into_packet_for_request(self, options: &str) -> Result<Vec<u8>, String> {
        let options: serde_json::Value = serde_json::from_str(options).map_err(|e| e.to_string())?;
        let enabled = match options.get("gpuPacketImages") {
            None | Some(serde_json::Value::Bool(false)) => false,
            Some(serde_json::Value::Bool(true)) => true,
            _ => return Err("Invalid GPU packet image policy".into()),
        };
        self.pack_images(enabled)
    }

    pub(super) fn pack_images(mut self, enabled: bool) -> Result<Vec<u8>, String> {
        let vertices = std::mem::take(&mut self.vertices);
        let curves = std::mem::take(&mut self.curves);
        // Hashes only choose a bucket; HashMap compares the complete strings.
        // Move the original allocation into the table, without copying pixels
        // or keeping another resource cache across documents/cancellations.
        let mut images: HashMap<String, usize> = HashMap::new();
        let mut intern = |paint: &mut Paint| {
            if let Some(image) = paint.image.take() {
                let next = images.len();
                let index = *images.entry(image).or_insert(next);
                paint.image = Some(index.to_string());
            }
        };
        if enabled {
            for node in self.nodes.values_mut() {
                for paint in &mut node.fills { intern(&mut paint.paint); }
                for stroke in &mut node.strokes { intern(&mut stroke.paint.paint); }
                if let Some(replay) = &mut node.texture_replay { intern(&mut replay.paint); }
            }
        }
        let mut ordered = vec![""; images.len()];
        for (image, index) in &images { ordered[*index] = image; }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Metadata<'a> {
            #[serde(flatten)] scene: &'a GpuScene,
            packet_image_lengths: Vec<usize>,
        }
        let metadata = if ordered.is_empty() {
            serde_json::to_vec(&self)
        } else {
            serde_json::to_vec(&Metadata { scene: &self,
                packet_image_lengths: ordered.iter().map(|image| image.len()).collect() })
        }.map_err(|e| e.to_string())?;
        let version = if ordered.is_empty() { 1 } else { 2 };
        finish_packet(metadata,vertices,curves,ordered,version)
    }
}

fn finish_packet(metadata: Vec<u8>, vertices: Vec<f32>, curves: Vec<f32>, images: Vec<&str>, version: usize) -> Result<Vec<u8>,String> {
        let image_bytes = images.iter().try_fold(0usize, |total, image|
            total.checked_add(image.len()).ok_or("GPU packet too large"))?;
        let metadata_end = 24usize.checked_add(metadata.len()).and_then(|n| n.checked_add(3))
            .map(|n| n & !3).ok_or("GPU packet too large")?;
        let total = vertices.len().checked_add(curves.len()).and_then(|n| n.checked_mul(4))
            .and_then(|n| n.checked_add(metadata_end)).and_then(|n| n.checked_add(image_bytes))
            .ok_or("GPU packet too large")?;
        let mut bytes = Vec::with_capacity(total);
        bytes.extend_from_slice(b"FGPK");
        for size in [version, metadata.len(), vertices.len(), curves.len(), image_bytes] {
            bytes.extend_from_slice(&u32::try_from(size).map_err(|_| "GPU packet too large")?.to_le_bytes());
        }
        bytes.extend_from_slice(&metadata);
        bytes.resize((bytes.len() + 3) & !3, 0);
        for value in vertices.iter().chain(&curves) { bytes.extend_from_slice(&value.to_le_bytes()); }
        for image in images { bytes.extend_from_slice(image.as_bytes()); }
        Ok(bytes)
}
