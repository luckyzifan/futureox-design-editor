use crate::sketch::{Error, Layer, LayerKind, Result};
use serde_json::Value;

/// A neutral coordinate payload, not a second geometry implementation.
pub type Point = [f64; 2];
#[derive(Debug, Clone, PartialEq)]
pub struct CurvePoint {
    pub point: Point,
    /// Outgoing control point (Sketch curveFrom), in local pixel coordinates.
    pub outgoing: Option<Point>,
    /// Incoming control point (Sketch curveTo), in local pixel coordinates.
    pub incoming: Option<Point>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct CurveContour {
    points: Vec<CurvePoint>,
    closed: bool,
}
/// Backend-owned path construction. Shared geometry/font/WebGPU adapters can
/// implement this interface without importing a Figma document or copying math.
/// Coordinates are layer-local; frame/rotation/paint/layout stay with the layer.
pub trait PathSink {
    type Error;
    fn move_to(&mut self, point: Point) -> std::result::Result<(), Self::Error>;
    fn line_to(&mut self, point: Point) -> std::result::Result<(), Self::Error>;
    fn cubic_to(
        &mut self,
        c1: Point,
        c2: Point,
        end: Point,
    ) -> std::result::Result<(), Self::Error>;
    fn close(&mut self) -> std::result::Result<(), Self::Error>;
}
fn number(value: Option<&Value>, name: &str) -> Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && v.abs() <= 1e7)
        .ok_or_else(|| Error::Invalid(format!("finite coordinate required: {name}")))
}
fn point(value: &Value) -> Result<Point> {
    if let Some(text) = value.as_str() {
        let text = text
            .trim()
            .strip_prefix('{')
            .and_then(|s| s.strip_suffix('}'))
            .ok_or_else(|| Error::Invalid("normalized point string".into()))?;
        let values: Vec<_> = text.split(',').collect();
        if values.len() != 2 {
            return Err(Error::Invalid("normalized point arity".into()));
        }
        let parse = |s: &str| {
            s.trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && v.abs() <= 1e7)
                .ok_or_else(|| Error::Invalid("normalized point coordinate".into()))
        };
        Ok([parse(values[0])?, parse(values[1])?])
    } else {
        Ok([number(value.get("x"), "x")?, number(value.get("y"), "y")?])
    }
}
impl CurveContour {
    pub fn points(&self) -> &[CurvePoint] {
        &self.points
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub fn from_layer(layer: &Layer) -> Result<Self> {
        if layer.kind() != LayerKind::ShapePath {
            return Err(Error::Unsupported("layer is not a native shapePath".into()));
        }
        let fields = layer.fields();
        let frame = fields
            .get("frame")
            .ok_or_else(|| Error::Missing("shape frame".into()))?;
        let width = number(frame.get("width"), "width")?;
        let height = number(frame.get("height"), "height")?;
        if width < 0. || height < 0. {
            return Err(Error::Invalid("negative shape size".into()));
        }
        let raw = path_field(fields, "points")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::Missing("curve points".into()))?;
        if raw.len() > 10_000 {
            return Err(Error::Limit("curve points"));
        }
        let scaled = |v: &Value| -> Result<Point> {
            let p = point(v)?;
            let out = [p[0] * width, p[1] * height];
            if out.iter().any(|v| !v.is_finite() || v.abs() > 1e7) {
                return Err(Error::Limit("local coordinate"));
            }
            Ok(out)
        };
        let mut points = Vec::with_capacity(raw.len());
        for value in raw {
            let position = scaled(
                value
                    .get("point")
                    .ok_or_else(|| Error::Missing("curve point".into()))?,
            )?;
            let control = |flag: &str, key: &str| -> Result<Option<Point>> {
                let enabled = match value.get(flag) {
                    None => false,
                    Some(v) => v
                        .as_bool()
                        .ok_or_else(|| Error::Invalid(format!("{flag} is not boolean")))?,
                };
                if enabled {
                    Ok(Some(scaled(
                        value.get(key).ok_or_else(|| Error::Missing(key.into()))?,
                    )?))
                } else {
                    Ok(None)
                }
            };
            points.push(CurvePoint {
                point: position,
                outgoing: control("hasCurveFrom", "curveFrom")?,
                incoming: control("hasCurveTo", "curveTo")?,
            });
        }
        let closed = match path_field(fields, "isClosed") {
            None => false,
            Some(v) => v
                .as_bool()
                .ok_or_else(|| Error::Invalid("isClosed is not boolean".into()))?,
        };
        Ok(Self { points, closed })
    }
    pub fn emit<S: PathSink>(&self, sink: &mut S) -> std::result::Result<(), S::Error> {
        let Some(first) = self.points.first() else {
            return Ok(());
        };
        sink.move_to(first.point)?;
        let edges = if self.closed {
            self.points.len()
        } else {
            self.points.len().saturating_sub(1)
        };
        for index in 0..edges {
            let start = &self.points[index];
            let end = &self.points[(index + 1) % self.points.len()];
            if start.outgoing.is_some() || end.incoming.is_some() {
                sink.cubic_to(
                    start.outgoing.unwrap_or(start.point),
                    end.incoming.unwrap_or(end.point),
                    end.point,
                )?;
            } else {
                sink.line_to(end.point)?;
            }
        }
        if self.closed {
            sink.close()?;
        }
        Ok(())
    }
}

/// Older Sketch archives wrap shape path points and closure in a path object.
/// Modern top-level fields stay authoritative when both forms are present.
pub(crate) fn path_field<'a>(
    fields: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a Value> {
    fields.get(key).or_else(|| fields.get("path")?.get(key))
}
