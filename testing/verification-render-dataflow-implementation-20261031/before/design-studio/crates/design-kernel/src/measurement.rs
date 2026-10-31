//! Measurement overlay: compute spacing between nodes for hover inspection.

use crate::{
    math::Point,
    scene::Document,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub node_id: String,
    pub direction: MeasurementDirection,
    pub distance: f64,
    pub start: Point,
    pub end: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_node: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeasurementDirection {
    Horizontal,
    Vertical,
}

/// Calculate measurements for a target node.
pub fn calculate_measurements(
    doc: &Document,
    target_id: &str,
) -> Result<Vec<Measurement>, String> {
    let target = doc.nodes.get(target_id).ok_or("Target node not found")?;
    if !target.visible {
        return Ok(Vec::new());
    }

    let target_x = target.transform.0[4];
    let target_y = target.transform.0[5];
    let target_w = target.width;
    let target_h = target.height;
    
    let mut measurements = Vec::new();

    // Find parent
    let parent_id = find_parent(doc, target_id);
    if let Some(parent_id) = parent_id {
        let parent = &doc.nodes[parent_id];

        if parent.kind == "frame" || parent.kind == "page" {
            let parent_x = parent.transform.0[4];
            let parent_y = parent.transform.0[5];
            let parent_w = parent.width;
            let parent_h = parent.height;

            // Top distance
            if target_y > parent_y {
                measurements.push(Measurement {
                    node_id: target_id.to_owned(),
                    direction: MeasurementDirection::Vertical,
                    distance: target_y - parent_y,
                    start: Point { x: target_x + target_w / 2.0, y: parent_y },
                    end: Point { x: target_x + target_w / 2.0, y: target_y },
                    related_node: None,
                });
            }

            // Left distance
            if target_x > parent_x {
                measurements.push(Measurement {
                    node_id: target_id.to_owned(),
                    direction: MeasurementDirection::Horizontal,
                    distance: target_x - parent_x,
                    start: Point { x: parent_x, y: target_y + target_h / 2.0 },
                    end: Point { x: target_x, y: target_y + target_h / 2.0 },
                    related_node: None,
                });
            }

            // Bottom distance
            if target_y + target_h < parent_y + parent_h {
                measurements.push(Measurement {
                    node_id: target_id.to_owned(),
                    direction: MeasurementDirection::Vertical,
                    distance: (parent_y + parent_h) - (target_y + target_h),
                    start: Point { x: target_x + target_w / 2.0, y: target_y + target_h },
                    end: Point { x: target_x + target_w / 2.0, y: parent_y + parent_h },
                    related_node: None,
                });
            }

            // Right distance
            if target_x + target_w < parent_x + parent_w {
                measurements.push(Measurement {
                    node_id: target_id.to_owned(),
                    direction: MeasurementDirection::Horizontal,
                    distance: (parent_x + parent_w) - (target_x + target_w),
                    start: Point { x: target_x + target_w, y: target_y + target_h / 2.0 },
                    end: Point { x: parent_x + parent_w, y: target_y + target_h / 2.0 },
                    related_node: None,
                });
            }
        }

        // Measure to siblings
        for sibling_id in &parent.children {
            if sibling_id == target_id {
                continue;
            }
            let sibling = &doc.nodes[sibling_id];
            if !sibling.visible {
                continue;
            }

            let s_x = sibling.transform.0[4];
            let s_y = sibling.transform.0[5];
            let s_w = sibling.width;
            let s_h = sibling.height;

            // Horizontal distance
            if target_x + target_w <= s_x {
                let dist = s_x - (target_x + target_w);
                if dist > 0.0 && dist < 1000.0 {
                    let y = (target_y + target_h / 2.0 + s_y + s_h / 2.0) / 2.0;
                    measurements.push(Measurement {
                        node_id: target_id.to_owned(),
                        direction: MeasurementDirection::Horizontal,
                        distance: dist,
                        start: Point { x: target_x + target_w, y },
                        end: Point { x: s_x, y },
                        related_node: Some(sibling_id.clone()),
                    });
                }
            } else if target_x >= s_x + s_w {
                let dist = target_x - (s_x + s_w);
                if dist > 0.0 && dist < 1000.0 {
                    let y = (target_y + target_h / 2.0 + s_y + s_h / 2.0) / 2.0;
                    measurements.push(Measurement {
                        node_id: target_id.to_owned(),
                        direction: MeasurementDirection::Horizontal,
                        distance: dist,
                        start: Point { x: s_x + s_w, y },
                        end: Point { x: target_x, y },
                        related_node: Some(sibling_id.clone()),
                    });
                }
            }

            // Vertical distance
            if target_y + target_h <= s_y {
                let dist = s_y - (target_y + target_h);
                if dist > 0.0 && dist < 1000.0 {
                    let x = (target_x + target_w / 2.0 + s_x + s_w / 2.0) / 2.0;
                    measurements.push(Measurement {
                        node_id: target_id.to_owned(),
                        direction: MeasurementDirection::Vertical,
                        distance: dist,
                        start: Point { x, y: target_y + target_h },
                        end: Point { x, y: s_y },
                        related_node: Some(sibling_id.clone()),
                    });
                }
            } else if target_y >= s_y + s_h {
                let dist = target_y - (s_y + s_h);
                if dist > 0.0 && dist < 1000.0 {
                    let x = (target_x + target_w / 2.0 + s_x + s_w / 2.0) / 2.0;
                    measurements.push(Measurement {
                        node_id: target_id.to_owned(),
                        direction: MeasurementDirection::Vertical,
                        distance: dist,
                        start: Point { x, y: s_y + s_h },
                        end: Point { x, y: target_y },
                        related_node: Some(sibling_id.clone()),
                    });
                }
            }
        }
    }

    measurements.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
    measurements.truncate(8);
    Ok(measurements)
}

fn find_parent<'a>(doc: &'a Document, child_id: &str) -> Option<&'a str> {
    for (id, node) in &doc.nodes {
        if node.children.iter().any(|c| c == child_id) {
            return Some(id.as_str());
        }
    }
    None
}
