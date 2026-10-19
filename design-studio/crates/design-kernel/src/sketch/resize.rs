//! Legacy native Sketch parent-resize proposals, without a foreign layout model.
//!
//! Set bits mean FLEXIBLE:
//! 4 = leading margin, 2 = size, 1 = trailing margin (Y uses the next three bits).
//! This bounded subset excludes degenerate/outside/overconstrained rectangles
//! rather than guessing native minimum-size, migration or transformed-layout rules.
use crate::sketch::{Error, Layer, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Frame {
    pub(crate) fn validate(&self) -> Result<()> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 1e9)
            || self.width < 0.5
            || self.height < 0.5
        {
            return Err(Error::Unsupported(
                "unsupported native frame geometry".into(),
            ));
        }
        Ok(())
    }
}

impl Layer {
    /// Propose this layer's frame when its immediate parent's local size changes.
    /// Does not mutate the document, recurse into children, resize paths/styles,
    /// or apply Smart/Stack Layout. Callers must not treat this as a tree edit.
    pub fn frame_for_parent_resize(&self, old: Size, new: Size) -> Result<Frame> {
        let frame = self.legacy_frame()?;
        let pins = self
            .resizing_constraints()?
            .ok_or_else(|| Error::Unsupported("missing legacy constraints".into()))?;
        let (x, width) = axis(frame.x, frame.width, old.width, new.width, pins.horizontal)?;
        let (y, height) = axis(frame.y, frame.height, old.height, new.height, pins.vertical)?;
        Ok(Frame {
            x,
            y,
            width,
            height,
        })
    }
    pub(crate) fn require_legacy_layout(&self) -> Result<()> {
        let fields = self.fields();
        for key in [
            "horizontalPins",
            "verticalPins",
            "horizontalSizing",
            "verticalSizing",
            "flexItem",
        ] {
            if [key.to_owned(), format!("_{key}"), format!("__{key}")]
                .iter()
                .any(|k| fields.contains_key(k))
            {
                return Err(Error::Unsupported(format!("modern layout field {key}")));
            }
        }
        for key in ["rotation", "resizingType"] {
            if fields.get(key).is_some_and(|v| v.as_f64() != Some(0.0)) {
                return Err(Error::Unsupported(format!("nonzero or unknown {key}")));
            }
        }
        // This frame solver supports untransformed legacy layout only. Keep
        // native flip data intact; do not silently treat true/unknown as false.
        for key in ["isFlippedHorizontal", "isFlippedVertical"] {
            if fields.get(key).is_some_and(|v| v.as_bool() != Some(false)) {
                return Err(Error::Unsupported(format!("flipped or unknown {key}")));
            }
        }
        Ok(())
    }
    pub(crate) fn legacy_frame(&self) -> Result<Frame> {
        self.require_legacy_layout()?;
        let fields = self.fields();
        let frame = fields
            .get("frame")
            .and_then(|v| v.as_object())
            .ok_or_else(|| Error::Invalid("missing native frame".into()))?;
        if frame
            .get("constrainProportions")
            .is_some_and(|v| v.as_bool() != Some(false))
        {
            return Err(Error::Unsupported("aspect-locked frame".into()));
        }
        let read = |key: &str| {
            frame
                .get(key)
                .and_then(|v| v.as_f64())
                .ok_or_else(|| Error::Invalid(format!("invalid frame {key}")))
        };
        let result = Frame {
            x: read("x")?,
            y: read("y")?,
            width: read("width")?,
            height: read("height")?,
        };
        result.validate()?;
        Ok(result)
    }
}

fn axis(start: f64, size: f64, old: f64, new: f64, bits: u8) -> Result<(f64, f64)> {
    if [start, size, old, new]
        .iter()
        .any(|v| !v.is_finite() || v.abs() > 1e9)
    {
        return Err(Error::Invalid(
            "nonfinite or oversized resize geometry".into(),
        ));
    }
    if start < 0.0 || size < 0.5 || old < 0.5 || new < 0.5 || start + size > old {
        return Err(Error::Unsupported(
            "degenerate or outside-parent resize geometry".into(),
        ));
    }
    let end = start + size;
    let trailing = old - end;
    let (position, extent) = match bits {
        // Both margins and size fixed is conflicting. Native mask 0 also has
        // special legacy normalization; do not reinterpret it implicitly.
        0 => return Err(Error::Unsupported("overconstrained legacy axis".into())),
        1 => (start, size),                   // leading edge + fixed size
        2 => (start, new - start - trailing), // both edges
        3 => (start, size * (new - start) / (old - start)),
        4 => (new - trailing - size, size), // trailing edge + fixed size
        5 => ((start + size / 2.0) * new / old - size / 2.0, size),
        6 => {
            // trailing edge, flexible size
            let new_end = new - trailing;
            let new_start = start * new_end / end;
            (new_start, new_end - new_start)
        }
        7 => (start * new / old, size * new / old), // fully proportional
        _ => return Err(Error::Invalid("invalid axis constraint bits".into())),
    };
    if !position.is_finite()
        || !extent.is_finite()
        || position < 0.0
        || extent < 0.5
        || position + extent > new + 1e-7
    {
        return Err(Error::Unsupported(
            "resize exceeds supported feasible bounds".into(),
        ));
    }
    Ok((position, extent))
}
