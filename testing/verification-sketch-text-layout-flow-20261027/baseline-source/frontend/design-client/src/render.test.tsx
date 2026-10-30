import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {demo,blank,node,paint,effect} from './model';
import {Scene} from './Renderer';
import {svgSource} from './export';
describe('shared scene and export rendering',()=>{
 it('exports all paint, clipping and background effect references',()=>{const d=demo(),{source}=svgSource(d,d.pages[0].id);const ids=new Set([...source.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));const refs=[...source.matchAll(/(?:href="#|url\(#)([^"\)]+)/g)].map(m=>m[1]);for(const ref of refs)expect(ids.has(ref),`missing SVG definition ${ref}`).toBe(true);expect(source).toContain('feDisplacementMap');expect(source).toContain('feTurbulence');expect(source).not.toContain('data-editor');});
 it('renders every selected effect in order',()=>{const d=blank(),n=node('rectangle');n.effects=['shadow','inner-shadow','blur','noise','texture'].map(k=>effect(k as Parameters<typeof effect>[0]));n.fills=[paint('#c01040','linear'),paint('#4050c0','radial')];d.nodes[n.id]=n;d.pages[0].children=[n.id];const {source}=svgSource(d,d.pages[0].id);expect(source).toContain('linearGradient');expect(source).toContain('radialGradient');expect(source).toContain('operator="out"');expect(source).toContain('feGaussianBlur');expect(source).toContain('feDisplacementMap');});
 it('clips masked children using an alpha mask',()=>{const d=blank(),g=node('group'),mask=node('ellipse'),child=node('rectangle');mask.mask=true;g.children=[mask.id,child.id];d.nodes={[g.id]:g,[mask.id]:mask,[child.id]:child};d.pages[0].children=[g.id];const output=renderToStaticMarkup(<svg><Scene doc={d} pageId={d.pages[0].id} exporting/></svg>);expect(output).toContain(`mask="url(#mask-${g.id})"`);expect(output).toContain('mask-type:alpha');});
});
