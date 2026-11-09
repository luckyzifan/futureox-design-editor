//! Frame requests: page and camera geometry, content revision, raster options
//! and color-space identity determine which rendered tiles remain reusable.

/// World-space rectangle `[x, y, width, height]` in page units — the same
/// domain [`crate::dirty_region`] emits and [`crate::tile_stack::raster_addresses`]
/// accepts.
pub type WorldRect = [f64; 4];

pub mod render_trait {
    /// Camera viewport moved (pan): existing tiles stay valid, only newly
    /// exposed tiles rasterise.
    pub const VIEWPORT: u64 = 1 << 0;
    /// The zoom bucket scale changed: a different mip level owns the content.
    pub const ZOOM_BUCKET: u64 = 1 << 1;
    /// Document content revision moved: tiles under the damage rect rasterise.
    pub const CONTENT: u64 = 1 << 2;
    /// Raster options (background, transparency, grid, raster profile) moved.
    pub const OPTIONS: u64 = 1 << 3;
    /// The document colour space changed: every level resets.
    pub const COLOR_SPACE: u64 = 1 << 4;
    /// Overlay state changed; reserved separately from content rasterization.
    pub const OVERLAY: u64 = 1 << 5;
}

/// Colour-space identity compared across levels. `ColorSettings` carries
/// parsed ICC profile bytes, so identity is a digest of its serialised form —
/// stable, cheap, and exact for the equality question the renderer asks.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ColorSpaceId(pub [u8; 32]);

impl ColorSpaceId {
    pub fn of(settings: &Option<crate::color::ColorSettings>) -> Self {
        use sha2::Digest;
        let digest: [u8; 32] = match settings {
            None => sha2::Sha256::digest(b"unmanaged").into(),
            Some(settings) => match serde_json::to_vec(settings) {
                Ok(bytes) => sha2::Sha256::digest(&bytes).into(),
                // Serialisation of validated settings cannot fail; a failure
                // still needs a stable value rather than a panic.
                Err(_) => sha2::Sha256::digest(b"color-settings-error").into(),
            },
        };
        ColorSpaceId(digest)
    }
}

#[derive(Clone, Debug)]
pub struct RenderInstruction {
    /// Page whose content is rendered.
    pub page_id: String,
    pub viewport: WorldRect,
    /// Live camera zoom. Content rasterises at `level_scale`; display
    /// resamples committed pixels down to this zoom.
    pub zoom: f64,
    pub level_scale: f64,
    /// Backing-store scale factor (Retina), applied on top of `level_scale`.
    pub backing_scale: f64,
    /// Monotonic engine revision observed for this frame.
    pub content_revision: u64,
    /// Raster-affecting options, compared as a small set of fields rather
    /// than the whole options struct: background transparency, grid, raster
    /// profile tag.
    pub options: InstructionOptions,
    /// Colour-space identity for level residency checks.
    pub color_space: ColorSpaceId,
}

impl PartialEq for RenderInstruction {
    fn eq(&self, other: &Self) -> bool {
        self.traits_differing(other) == 0
    }
}
impl Eq for RenderInstruction {}

/// The option subset that leaves the raster bytes domain when it changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstructionOptions {
    pub transparent: bool,
    pub grid: bool,
    /// Tag of the raster profile (Analytic / Figma / export…): different
    /// profiles produce different bytes for identical geometry.
    pub raster_profile: &'static str,
    /// Interactive presentation tier: the effect-degradation policy changes
    /// raster bytes for managed documents, so tile identity must see it.
    pub interactive_effects: bool,
    /// Canvas checkerboard chrome: changes the background bytes, so tile
    /// identity must see it.
    pub checkerboard: bool,
}

impl InstructionOptions {
    pub fn new(transparent: bool, grid: bool, raster_profile: &'static str) -> Self {
        InstructionOptions {
            transparent,
            grid,
            raster_profile,
            interactive_effects: false,
            checkerboard: false,
        }
    }
    pub fn with_interactive_effects(mut self, on: bool) -> Self {
        self.interactive_effects = on;
        self
    }
    pub fn with_checkerboard(mut self, on: bool) -> Self {
        self.checkerboard = on;
        self
    }
}

impl RenderInstruction {
    /// Bitmask of traits that differ from `previous`; zero means the
    /// instructions are equal and no rasterisation is required.
    pub fn traits_differing(&self, previous: &RenderInstruction) -> u64 {
        let mut traits = 0u64;
        if self.viewport != previous.viewport {
            traits |= render_trait::VIEWPORT;
        }
        if self.level_scale != previous.level_scale {
            traits |= render_trait::ZOOM_BUCKET;
        }
        if self.content_revision != previous.content_revision {
            traits |= render_trait::CONTENT;
        }
        if self.options != previous.options {
            traits |= render_trait::OPTIONS;
        }
        if self.color_space != previous.color_space {
            traits |= render_trait::COLOR_SPACE;
        }
        // No overlay state exists in the kernel yet; the trait bit stays
        // reserved so downstream masks keep Sketch's shape.
        let _ = render_trait::OVERLAY;
        traits
    }

    /// Exact-equality predicate, the `isEqualToRenderInstruction:` role.
    pub fn is_equal_to_instruction(&self, other: &RenderInstruction) -> bool {
        self == other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instruction(zoom: f64, revision: u64) -> RenderInstruction {
        RenderInstruction {
            page_id: "page-1".into(),
            viewport: [0., 0., 1024., 768.],
            zoom,
            level_scale: crate::tile_stack::exact_bucket_scale(zoom),
            backing_scale: 1.,
            content_revision: revision,
            options: InstructionOptions::new(false, false, "analytic"),
            color_space: ColorSpaceId::of(&None),
        }
    }

    #[test]
    fn equal_instructions_report_no_traits() {
        let a = instruction(1., 7);
        let b = instruction(1., 7);
        assert!(a.is_equal_to_instruction(&b));
        assert_eq!(a.traits_differing(&b), 0);
    }

    #[test]
    fn zoom_inside_one_bucket_keeps_the_level() {
        // 1.3 and 1.4 both rasterise at bucket scale 2: content bytes are
        // identical and the live zoom is a compositor resample, so the
        // instructions compare equal — no re-rasterisation.
        let a = instruction(1.3, 7);
        let b = instruction(1.4, 7);
        assert_eq!(a.traits_differing(&b), 0);
        assert!(a.is_equal_to_instruction(&b));
        // A pan (viewport move) is a real trait, but one that needs no
        // re-rasterisation of already-covered tiles.
        let mut panned = instruction(1.3, 7);
        panned.viewport = [512., 0., 1024., 768.];
        assert_eq!(
            a.traits_differing(&panned),
            render_trait::VIEWPORT,
            "only the viewport trait differs"
        );
    }

    #[test]
    fn content_options_and_colour_traits_are_independent() {
        let mut a = instruction(1., 7);
        let mut b = instruction(1., 7);
        b.content_revision = 8;
        assert_eq!(a.traits_differing(&b), render_trait::CONTENT);
        b.options.grid = true;
        assert_eq!(
            a.traits_differing(&b),
            render_trait::CONTENT | render_trait::OPTIONS
        );
        a.color_space = ColorSpaceId::of(&Some(crate::color::ColorSettings::default()));
        assert_ne!(a.traits_differing(&b) & render_trait::COLOR_SPACE, 0);
    }
}
