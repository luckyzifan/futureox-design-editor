from pathlib import Path
r=Path('.')
def edit(name,fn):
 p=r/name;s=p.read_text();v=fn(s);assert v!=s,name;p.write_text(v)
base='design-studio/crates/design-kernel/src/'
# Every explicit constructor gets the additive optional parameter.
for name in ['interop.rs','fig.rs','sketch/preview/display.rs']:
 edit(base+name,lambda s:s.replace('motion_angle: 0.,','zoom_blur: None, motion_angle: 0.,').replace('motion_angle:0.','zoom_blur:None,motion_angle:0.'))
def scene(s):
 s=s.replace('pub struct Effect {','pub struct Effect {\n    #[serde(default, rename="zoomBlur", skip_serializing_if="Option::is_none")]\n    pub zoom_blur: Option<crate::zoom_blur::ZoomBlur>,',1)
 s=s.replace('    pub fn validate_material(&self) -> Result<(), String> {','''    pub fn validate_material(&self) -> Result<(), String> {
        if (self.kind=="zoom-blur") != self.zoom_blur.is_some() || self.zoom_blur.is_some_and(|p|!p.validate()
            || self.radius!=0. || self.color_controls.is_some() || self.glass.is_some() || self.texture.is_some() || self.gradient_blur.is_some()) {
            return Err("Invalid zoom blur parameters".into());
        }''',1)
 s=s.replace('!matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur")','!matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur"|"zoom-blur")',1)
 s=s.replace('.map(|e|if e.radius>0. {3.*e.radius*scale+2.} else {0.}).sum::<f64>()','.map(|e|if e.radius>0. {3.*e.radius*scale+2.} else {0.}).sum::<f64>()\n            +self.effects.iter().filter(|e|e.visible).filter_map(|e|e.zoom_blur).map(|z|if z.amount>0. {3.*z.amount*scale+2.} else {0.}).sum::<f64>()',1)
 a=s.index('    pub fn requires_schema18');b=s.index('    pub fn requires_schema17',a);method=s[a:b].replace('requires_schema18','requires_schema19').replace('"gaussian-blur"|"motion-blur"','"zoom-blur"');s=s[:a]+method+s[a:]
 s=s.replace('        if self.schema_version<18 && self.requires_schema18()', '        if self.schema_version<19 && self.requires_schema19() {return Err("Zoom blur requires schema 19".into());}\n        if self.schema_version<18 && self.requires_schema18()',1)
 s=s.replace('16, 17, 18].contains','16, 17, 18, 19].contains',1)
 return s
edit(base+'scene.rs',scene)
for name in ['animation.rs','design_system.rs','dirty_region.rs','gpu/scene_plan.rs']:
 edit(base+name,lambda s:s.replace('"gaussian-blur" | "motion-blur"','"gaussian-blur" | "motion-blur" | "zoom-blur"').replace('"gaussian-blur"|"motion-blur"','"gaussian-blur"|"motion-blur"|"zoom-blur"'))
edit(base+'animation.rs',lambda s:s.replace('        e.motion_angle = mix(a.motion_angle,b.motion_angle,t);','''        e.motion_angle = mix(a.motion_angle,b.motion_angle,t);
        if let (Some(o),Some(a),Some(b))=(&mut e.zoom_blur,a.zoom_blur,b.zoom_blur) {
            o.amount=mix(a.amount,b.amount,t);o.center=std::array::from_fn(|i|mix(a.center[i],b.center[i],t));
        }'''))
def render(s):
 s=s.replace('if matches!(fx.kind.as_str(), "gaussian-blur" | "motion-blur") {','if matches!(fx.kind.as_str(), "gaussian-blur" | "motion-blur" | "zoom-blur") {',1)
 s=s.replace('let mut value=if let Some(kernel)=&kernel {kernel.apply(source)?}','let mut value=if let Some(z)=fx.zoom_blur {crate::zoom_blur::apply(source,z,m,[n.width,n.height])?}\n                        else if let Some(kernel)=&kernel {kernel.apply(source)?}',1)
 s=s.replace('                "gaussian-blur" => { layer=', '                "zoom-blur" => { layer=crate::zoom_blur::apply(&layer,fx.zoom_blur.ok_or("Missing zoom parameters")?,m,[n.width,n.height])?; }\n                "gaussian-blur" => { layer=',1)
 return s
edit(base+'renderer.rs',render)
def interop(s):
 s=s.replace('"gaussian-blur" | "motion-blur"','"gaussian-blur" | "motion-blur" | "zoom-blur"')
 s=s.replace('1 => Some("motion-blur"),','1 => Some("motion-blur"),\n                2 => Some("zoom-blur"),',1)
 s=s.replace('                motion_angle: if kind=="motion-blur"','                zoom_blur: (kind=="zoom-blur").then(|| {let (x,y)=blur.get("center").map(point_xy).unwrap_or((0.5,0.5));crate::zoom_blur::ZoomBlur{amount:f64_at(blur,"radius"),center:[x,y]}}),\n                motion_angle: if kind=="motion-blur"',1)
 # Only the blur block has this exact adjacency.
 s=s.replace('kind: kind.into(),\n                visible: true,\n                radius: f64_at(blur, "radius"),','kind: kind.into(),\n                visible: true,\n                radius: if kind=="zoom-blur" {0.} else {f64_at(blur, "radius")},',1)
 s=s.replace('0 | 1 | 3 => {},\n                        2 => import_lossy.push("zoom-blur-not-modeled;source-blur-retained".into()),','0 | 1 | 2 | 3 => {},',1)
 s=s.replace('"gaussian-blur"|"motion-blur"','"gaussian-blur"|"motion-blur"|"zoom-blur"')
 s=s.replace('    if doc.requires_schema18() { version=version.max(18); }','    if doc.requires_schema18() { version=version.max(18); }\n    if doc.requires_schema19() { version=version.max(19); }',1)
 s=s.replace('"motionAngle": e.motion_angle, "radius": e.radius.max(0.),','"motionAngle": e.motion_angle, "radius": e.zoom_blur.map_or(e.radius.max(0.),|z|z.amount),',1)
 s=s.replace('"isEnabled": e.visible, "center": "{0.5, 0.5}",','"isEnabled": e.visible, "center": e.zoom_blur.map_or_else(||"{0.5, 0.5}".to_string(),|z|format!("{{{}, {}}}",z.center[0],z.center[1])),',1)
 s=s.replace('else if e.kind=="motion-blur" {1} else {0}','else if e.kind=="motion-blur" {1} else if e.kind=="zoom-blur" {2} else {0}',1)
 return s
edit(base+'interop.rs',interop)
