//! Layer color controls, distinct from Figma image-paint adjustments.
//! Saturation -> contrast -> brightness -> hue, in the current working space.
//! The Core Image basis/ordering is recorded by coreimage-color-probe.swift.
//! RGB may remain negative or above reference white; alpha is never adjusted.
use crate::blend::{Pixel, Surface};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorControls {
    /// None operates in working pixels. Sketch bitmap controls use encoded
    /// document RGB; keeping this explicit prevents a global color change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<crate::color::ColorSpace>,
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    /// Radians, matching CIHueAdjust and the Sketch archive.
    pub hue: f64,
}
impl Default for ColorControls {
    fn default() -> Self { Self { space:None, brightness:0., contrast:1., saturation:1., hue:0. } }
}
impl ColorControls {
    pub fn validate(&self) -> bool {
        self.space.is_none_or(|s| matches!(s, crate::color::ColorSpace::Srgb | crate::color::ColorSpace::DisplayP3))
            && self.brightness.is_finite() && (-1. ..=1.).contains(&self.brightness)
            && self.contrast.is_finite() && (0. ..=4.).contains(&self.contrast)
            && self.saturation.is_finite() && (0. ..=4.).contains(&self.saturation)
            && self.hue.is_finite() && self.hue.abs() <= 1e7
    }
    pub fn is_identity(&self) -> bool { self.brightness==0. && self.contrast==1. && self.saturation==1. && self.hue==0. }
    /// Three rows of (R,G,B,bias), uploaded verbatim to both GPU backends.
    /// Multiplying bias by the source alpha evaluates straight-color controls
    /// directly on premultiplied pixels, without dividing tiny alpha values.
    pub fn matrix(&self) -> [f32; 12] {
        if self.is_identity() { return [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0.]; }
        let luma = [0.2125_f32,0.7154,0.0721];
        let saturation = self.saturation as f32;
        let contrast = self.contrast as f32;
        let bias = self.brightness as f32 + 0.5 * (1. - contrast);
        let mut controls = [[0_f32; 4]; 3];
        for row in 0..3 { for col in 0..3 {
            controls[row][col] = ((1. - saturation) * luma[col]
                + if row == col { saturation } else { 0. }) * contrast;
        } controls[row][3] = bias; }
        if self.hue == 0. { return std::array::from_fn(|i|controls[i/4][i%4]); }
        let (sin, cos) = (self.hue as f32).sin_cos();
        // These are the native CIHueAdjust coefficients, not the rounded
        // SVG hueRotate matrix (whose green-row sine coefficients differ).
        let sine = [[-0.2125,-0.7154,0.9279],[0.1404,0.1404,-0.2846],[-0.7875,0.7154,0.0721]];
        let hue: [[f32; 3]; 3] = std::array::from_fn(|row|std::array::from_fn(|col|
            luma[col] + ((if row == col {1.} else {0.}) - luma[col]) * cos + sine[row][col] * sin));
        std::array::from_fn(|i| {
            let (row,col) = (i/4,i%4);
            (hue[row][0]*controls[0][col] + hue[row][1]*controls[1][col]) + hue[row][2]*controls[2][col]
        })
    }
    pub fn uniforms(&self, managed: bool) -> [f32; 40] {
        let mut result=[0_f32;40]; result[..12].copy_from_slice(&self.matrix());
        if !managed || self.space.is_none() { return result; }
        result[12]=1.;
        let settings=crate::color::ColorSettings::default();
        let linear=if self.space==Some(crate::color::ColorSpace::DisplayP3) {crate::color::ColorSpace::LinearP3} else {crate::color::ColorSpace::LinearSrgb};
        for col in 0..3 {
            let basis=std::array::from_fn(|i|f64::from(i==col));
            let pre=settings.from_working(basis,linear); let post=settings.to_working(basis,linear);
            for row in 0..3 {result[16+row*4+col]=pre[row] as f32;result[28+row*4+col]=post[row] as f32;}
        }
        result
    }
    pub fn apply(&self, surface: &mut Surface, managed: bool) {
        if self.is_identity() { return; }
        let matrix = self.matrix();
        let settings=crate::color::ColorSettings::default();
        let conversion=self.space.filter(|_|managed).map(|space|(space,settings.prepare_from_working(space)));
        for pixel in &mut surface.pixels {
            if let Some((space, transform))=&conversion {
                let alpha=pixel.0[3];if alpha==0. {continue}
                let input=transform.apply([0,1,2].map(|i|f64::from(pixel.0[i])/f64::from(alpha)));
                let encoded=apply_matrix(Pixel([input[0] as f32,input[1] as f32,input[2] as f32,1.]),&matrix);
                let output=settings.to_working([0,1,2].map(|i|f64::from(encoded.0[i])),*space);
                *pixel=Pixel([output[0] as f32*alpha,output[1] as f32*alpha,output[2] as f32*alpha,alpha]);
            } else { *pixel = apply_matrix(*pixel, &matrix); }
        }
    }
}
pub fn apply_matrix(pixel: Pixel, matrix: &[f32; 12]) -> Pixel {
    let p = pixel.0;
    if p[3] == 0. { return pixel; }
    Pixel(std::array::from_fn(|i| if i==3 {p[3]} else {
        let row = &matrix[i*4..i*4+4];
        ((p[0]*row[0] + p[1]*row[1]) + p[2]*row[2]) + p[3]*row[3]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_coreimage_color_vectors() {
        let oracle:serde_json::Value=serde_json::from_str(include_str!("../../../../testing/fixtures/design/coreimage-color-controls-vectors.json")).unwrap();
        for case in oracle["results"].as_array().unwrap() {
            let p:Vec<f64>=serde_json::from_value(case["parameters"].clone()).unwrap();
            let control=ColorControls{saturation:p[0],brightness:p[1],contrast:p[2],hue:p[3],..Default::default()};
            for (input,expected) in oracle["input"].as_array().unwrap().iter().zip(case["pixels"].as_array().unwrap()) {
                let input:[f32;4]=serde_json::from_value(input.clone()).unwrap();
                let expected:[f32;4]=serde_json::from_value(expected.clone()).unwrap();
                let result=apply_matrix(Pixel(input),&control.matrix()).0;
                for i in 0..4 { assert!((result[i]-expected[i]).abs()<=2e-6,"{p:?} {input:?}: {result:?} != {expected:?}"); }
                assert_eq!(result[3].to_bits(),input[3].to_bits());
            }
        }
    }
    #[test]
    fn bounds_and_identity() {
        assert!(ColorControls::default().validate());
        for value in [f64::NAN,f64::INFINITY,-0.1,4.1] {
            assert!(!ColorControls{saturation:value,..Default::default()}.validate());
        }
        let p=Pixel([2.,-0.25,0.5,1.]);
        assert_eq!(apply_matrix(p,&ColorControls::default().matrix()),p);
    }
}
