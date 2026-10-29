//! Ruler/inspector unit conversion at the reference's 96 dpi anchor
//! (INTERACTION-DETAILS-2026-10-26 §4, func[2411] @0x7cc88).
//!
//! The recovered per-unit expressions convert a physical-unit value into
//! CSS/device pixels: pt `×96/72` (case 4), pica `×96/6` (case 5), mm
//! `×96/25.4` (case 7), inch `×96` (case 8); cm rides the mm path ×10
//! (case 0's ÷100 and case 6's `×96/2.5` targets were not named in the
//! recovery and are deliberately not modeled). The same function serves
//! rulers, the properties panel and size inputs (28 callers).

/// Device pixels per inch — the anchor of every factor below.
pub const PX_PER_INCH: f64 = 96.;
/// 1 pt = 1/72 inch (`0x1.2p+6` ÷ 72 at disasm case 4).
pub const PX_PER_PT: f64 = 96. / 72.;
/// 1 pica = 1/6 inch (case 5, `0x1.8p+2`).
pub const PX_PER_PICA: f64 = 96. / 6.;
/// 1 mm = 1/25.4 inch (case 7, `0x1.9666666666666p+4`).
pub const PX_PER_MM: f64 = 96. / 25.4;
/// 1 cm = 10 mm via the same path (`96 / 2.54`).
pub const PX_PER_CM: f64 = 96. / 2.54;

/// Ruler/display units supported by the recovered conversion table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RulerUnit {
    Pixels,
    Points,
    Picas,
    Millimeters,
    Centimeters,
    Inches,
}

impl RulerUnit {
    /// Pixels per one unit at the 96 dpi anchor.
    pub fn px_per_unit(self) -> f64 {
        match self {
            Self::Pixels => 1.,
            Self::Points => PX_PER_PT,
            Self::Picas => PX_PER_PICA,
            Self::Millimeters => PX_PER_MM,
            Self::Centimeters => PX_PER_CM,
            Self::Inches => PX_PER_INCH,
        }
    }

    /// Physical-unit value → pixels (the direction func[2411] computes).
    pub fn to_px(self, value: f64) -> f64 {
        value * self.px_per_unit()
    }

    /// Pixels → physical-unit value for display.
    pub fn from_px(self, px: f64) -> f64 {
        px / self.px_per_unit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factors_match_the_recovered_constants() {
        assert_eq!(PX_PER_PT, 96. / 72.);
        assert_eq!(PX_PER_PICA, 16.);
        assert!((PX_PER_MM - 96. / 25.4).abs() < 1e-12);
        assert_eq!(PX_PER_CM, PX_PER_MM * 10.);
        assert_eq!(PX_PER_INCH, 96.);
    }

    #[test]
    fn round_trips_through_px() {
        for unit in [
            RulerUnit::Pixels,
            RulerUnit::Points,
            RulerUnit::Picas,
            RulerUnit::Millimeters,
            RulerUnit::Centimeters,
            RulerUnit::Inches,
        ] {
            let value = 3.5;
            assert!(
                (unit.from_px(unit.to_px(value)) - value).abs() < 1e-9,
                "{unit:?} round trip"
            );
        }
    }

    #[test]
    fn known_equivalences_hold() {
        assert!((RulerUnit::Points.to_px(72.) - 96.).abs() < 1e-12);
        assert!((RulerUnit::Picas.to_px(6.) - 96.).abs() < 1e-12);
        assert!((RulerUnit::Inches.to_px(1.) - 96.).abs() < 1e-12);
        assert!((RulerUnit::Millimeters.to_px(25.4) - 96.).abs() < 1e-9);
        assert!((RulerUnit::Centimeters.to_px(2.54) - 96.).abs() < 1e-9);
        assert!((RulerUnit::Points.from_px(96.) - 72.).abs() < 1e-9);
    }
}
