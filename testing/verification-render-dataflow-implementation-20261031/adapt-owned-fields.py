from pathlib import Path
import re
root=Path('design-studio/crates/design-kernel/src')
fields='repeat|vector_brush|text_path|connector|board|layout_grid|text_style|component|instance|instance_origin|network'
for p in root.rglob('*.rs'):
 s=p.read_text();edits=[]
 for m in re.finditer(r'\.(?:'+fields+r')\s*=\s*Some\(',s):
  a=m.end();i=a;depth=1;quote=False;escape=False
  while i<len(s) and depth:
   c=s[i]
   if quote:
    if escape:escape=False
    elif c=='\\':escape=True
    elif c=='"':quote=False
   elif c=='"':quote=True
   elif c=='(':depth+=1
   elif c==')':depth-=1
   i+=1
  if depth:raise RuntimeError(p)
  b=i-1;value=s[a:b]
  if 'serde_json::from_' in value or value.rstrip().endswith('.into()'):continue
  # Known typed constructor/local values; .into() also preserves already-boxed values.
  edits.append((a,b,'('+value+').into()'))
 for a,b,t in reversed(edits):s=s[:a]+t+s[b:]
 if edits:p.write_text(s)
# Type conversions at interfaces that intentionally keep owned values.
replacements={
 'repeat.rs':[( '.map_or(0,Repeat::work)', '.map_or(0,|r|r.work())')],
 'font.rs':[( 'node.text_path.as_ref()', 'node.text_path.as_deref()')],
 'components.rs':[( 'n.instance_origin = origin;', 'n.instance_origin = origin.map(Box::new);')],
 'fig.rs':[( 'node.network = material.network;', 'node.network = material.network.map(Into::into);')],
 'interop.rs':[( 'node.text_style = saved_style;', 'node.text_style = saved_style.map(Box::new);'),('text_style: node.text_style.clone(),','text_style: node.text_style.as_deref().cloned(),')],
}
for f,changes in replacements.items():
 p=root/f;s=p.read_text()
 for a,b in changes:s=s.replace(a,b)
 p.write_text(s)
# These are serialized transfer values, so Arc remains transparent on their wire.
for f in ['animation.rs','layout.rs']:
 p=root/f;s=p.read_text().replace('network: Option<Network>', 'network: Option<std::sync::Arc<Network>>').replace('network: Option<crate::scene::Network>', 'network: Option<std::sync::Arc<crate::scene::Network>>');p.write_text(s)
# Explicit COW at geometry mutation sites.
p=root/'mutation.rs';s=p.read_text().replace('if let Some(g) = &mut n.network {','if let Some(g) = &mut n.network {\n        let g = std::sync::Arc::make_mut(g);');p.write_text(s)
p=root/'interop.rs';s=p.read_text().replace('&& let Some(network) = &mut node.network\n        {','&& let Some(network) = &mut node.network\n        {\n            let network = std::sync::Arc::make_mut(network);');p.write_text(s)
p=root/'animation.rs';s=p.read_text().replace('(&mut out.network, &a.network, &b.network) {','(&mut out.network, &a.network, &b.network) {\n        let out = std::sync::Arc::make_mut(out);');p.write_text(s)
