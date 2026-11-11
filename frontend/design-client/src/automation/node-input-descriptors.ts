/** Native authored-node inputs. Bounds mirror model.ts/validateDocument,
 * stroke-profile.ts, and kernel scene/font/text_path/connectors validators.
 * These are whole-property replacements, not recursive merge patches.
 * Document/kind/reference and cross-field constraints remain model-authoritative.
 */
import { MAX_GRADIENT_STOPS, blendModes, type DesignNode } from '../model'
type Schema = Record<string, unknown>
const num = (minimum = -1e7, maximum = 1e7): Schema => ({ type: 'number', minimum, maximum })
const integer = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum })
const str = (maxLength?: number): Schema => ({ type: 'string', ...(maxLength === undefined ? {} : { maxLength }) })
const en = (...values: readonly string[]): Schema => ({ type: 'string', enum: values })
const bool: Schema = { type: 'boolean' }
const array = (items: Schema, maxItems: number, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems })
const tuple = (items: Schema, length: number) => array(items, length, length)
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const nullable = (value: Schema): Schema => ({ anyOf: [value, { type: 'null' }] })
const describe = (value: Schema, description: string): Schema => ({ ...value, description })
const id = { type: 'string', minLength: 1, maxLength: 128 }
const unit = num(0, 1)
const point = obj({ x: num(), y: num() }, ['x', 'y'])
const color = describe(str(), 'Native color string; validated against document color-management settings.')
export const nodeTransformSchema = describe(tuple(num(), 6), 'Parent-local affine matrix [a,b,c,d,tx,ty]: x′=a*x+c*y+tx, y′=b*x+d*y+ty. Negative coordinates, reflection and negative scales are allowed. Absolute determinant |a*d-b*c| must be at least 1e-9; singular matrices are rejected by model validation.')
const paintTransform = describe(tuple(num(), 6), 'Paint affine matrix [a,b,c,d,tx,ty]; absolute determinant must be at least 1e-12.')
const paint = obj({
  id: str(), kind: en('solid', 'linear', 'radial', 'image', 'angular', 'diamond'), color, opacity: unit,
  visible: bool, angle: num(), stops: describe(array(obj({ offset: unit, color }, ['offset', 'color']), MAX_GRADIENT_STOPS), 'Gradient kinds require at least two stops.'),
  image: describe(nullable(str()), 'PNG/JPEG/WebP base64 data URL; subject to request byte budget.'), fit: en('cover', 'contain', 'stretch'), blend: en(...blendModes), transform: nullable(paintTransform),
  adjust: describe(obj({ exposure: num(-1, 1), contrast: num(-1, 1), temperature: num(-1, 1), tint: num(-1, 1), highlights: num(-1, 1), shadows: num(-1, 1), color: num(-1, 1), highlightShadowThreshold: unit }), 'Image paints only; missing adjustments use identity defaults.'),
  tile: describe(obj({
    mode: en('none', 'grid', 'stagger_horizontal', 'stagger_vertical'), size: tuple(num(0), 2), offset: tuple(num(), 2),
    alignment: tuple(en('start', 'center', 'end'), 2), scale: num(Number.MIN_VALUE, 1e6), rotation: num(-1e6, 1e6), spacing: tuple(num(0, 1e7), 2),
  }, ['mode', 'size', 'offset']), 'Image paints only. Zero size uses the native image extent; scale multiplies that extent and does not rescale an explicit size. Rotation is degrees about the alignment pin. Spacing is the transparent gap after the image. Alignment pins the scaled image to the fill: start, center, or end.'),
}, ['kind', 'color', 'opacity', 'angle', 'stops'])
const marker = en('none', 'arrow', 'triangle', 'circle', 'diamond', 'square', 'bar')
const stroke = obj({ id: str(), paint, width: num(0, 10000), align: en('inside', 'center', 'outside'), cap: en('butt', 'round', 'square'), join: en('miter', 'round', 'bevel'), dash: describe(str(1000), 'Comma/space-separated nonnegative dash lengths; nonzero values must be at least 1e-6 and at most 1e7.'), dashOffset: num(), visible: bool, startMarker: marker, endMarker: marker,
  widthProfile: describe(array(obj({ position: unit, left: num(0, 4), right: num(0, 4) }, ['position', 'left', 'right']), 512), 'Positions must increase by at least 1e-6. Branched networks/text are unsupported; closed paths require matching endpoint widths.'),
}, ['paint', 'width', 'align', 'cap', 'join', 'dash'])
const colorControls = obj({ space: en('srgb','display-p3'), brightness: num(-1,1), contrast: num(0,4), saturation: num(0,4), hue: describe(num(), "Hue angle in radians, bounded to +/- 1e7.") }, ["brightness","contrast","saturation","hue"])
const effect = obj({ zoomBlur: describe(obj({amount:num(0,1000),center:tuple(num(-1e6,1e6),2)}, ['amount','center']), 'Zoom-blur only: dimensionless amount, normalized node-local focal point; radius must be zero.'), colorControls, motionAngle: describe(num(-1e7,1e7), "Motion blur direction in node-local degrees; radius is Gaussian sigma."), id: str(), kind: en('shadow', 'inner-shadow', 'blur', 'background-blur', 'glass', 'noise', 'texture', 'color-controls', 'gaussian-blur', 'motion-blur', 'zoom-blur'), visible: bool, radius: num(0, 1000), x: num(), y: num(), spread: num(), color, opacity: unit, amount: num(),
  showShadowBehindNode: describe(bool, 'Optional FIG drop-shadow flag. Preserved on import; the renderer does not yet branch shadow clipping on this value.'),
  glass: describe(obj({ bevelSize: num(0.001, 1000), depth: num(1, 1000), refraction: unit, dispersion: unit, lightAngle: num(), lightIntensity: unit }, ['depth', 'refraction', 'dispersion', 'lightAngle', 'lightIntensity']), 'Glass kind only; mutually exclusive with texture/gradientBlur.'),
  texture: describe(obj({ noiseSize: tuple(num(0.001, 10000), 2), clipToShape: bool, noise: en('figma', 'gabor', 'perlin') }, ['noiseSize', 'clipToShape']), 'Texture kind only; mutually exclusive with glass/gradientBlur.'),
  gradientBlur: describe(obj({ start: tuple(num(), 2), end: tuple(num(), 2), startCount: num(0, 64), endCount: num(0, 64), smooth: bool }, ['start', 'end', 'startCount', 'endCount', 'smooth']), 'Blur kind only; mutually exclusive with glass/texture.'),
}, ['kind', 'radius', 'x', 'y', 'spread', 'color', 'opacity', 'amount'])
for (const key of ['glass', 'texture', 'gradientBlur', 'colorControls']) {
  const properties = effect.properties as Record<string, Schema>
  properties[key] = nullable(properties[key])
}
const network = describe(obj({ vertices: array(obj({ id: str(), x: num(), y: num() }, ['id', 'x', 'y']), 10000), edges: array(obj({ id: str(), from: str(), to: str(), c1: nullable(point), c2: nullable(point) }, ['id', 'from', 'to']), 20000), fillRule: en('evenodd', 'nonzero'), filledFaces: array(array(str(), 10000), 10000) }, ['vertices', 'edges']), 'Vertex and edge IDs must be unique; edges reference existing vertices and filledFaces reference existing edges.')
const align = en('start', 'center', 'end', 'stretch')
const curve:Schema={anyOf:[en('close'),...Object.entries({move:2,line:2,quad:4,cubic:6}).map(([key,length])=>obj({[key]:tuple(num(),length)},[key]))]}
const vectorGeometry=describe(obj({fillRule:en('evenodd','nonzero'),fill:array(curve,131072),stroke:array(curve,131072)},['fillRule','fill']), 'Schema 16 f64 render curves, at most 131072 commands in total. Fill contours close explicitly. Mutually exclusive with network, booleans and vector brush; point editing materializes a separately admitted network.')
const textCase = en('original', 'upper', 'lower')
const textParagraph = obj({ align: en('start','center','end','justify'), minimumLineHeight: num(0,10000), maximumLineHeight: num(0,10000), spacing: num(0,10000), indent: num(-10000,10000) }, ['align','minimumLineHeight','maximumLineHeight','spacing','indent'])
const textStyle = obj({ verticalAlign: en('top','center','bottom'), fontId: describe(id, 'default or an existing document font ID.'), fallbacks: array(id, 16), weight: num(1, 1000), lineHeight: num(0.1, 10), letterSpacing: num(-1000, 1000), wrap: bool, align: en('start', 'center', 'end', 'justify'), direction: en('auto', 'ltr', 'rtl'), paragraphSpacing: num(0, 10000), paragraphIndent: num(-10000, 10000), textCase, writingMode: en('horizontal', 'vertical'), features: describe(array(str(32), 16), 'Valid HarfBuzz/OpenType feature syntax, e.g. -liga or kern.'), variations: array(obj({ tag: describe({ type: 'string', minLength: 4, maxLength: 4 }, 'Four ASCII alphanumeric characters; wght is reserved, use weight instead.'), value: num(-10000, 10000) }, ['tag', 'value']), 16) })
const endpoint = obj({ point, nodeId: nullable(id), anchor: nullable(obj({ x: unit, y: unit }, ['x', 'y'])) }, ['point'])
/** Null on these top-level fields removes the property, preserving patchNode semantics. */
export const OPTIONAL_NODE_FIELDS = new Set<string>(['vectorGeometry','vectorBrush', 'repeat', 'network', 'textStyle', 'textRuns', 'layout', 'sizing', 'constraints', 'layoutGrid', 'guides', 'arc', 'cornerRadius', 'constrainProportions', 'booleanOperation', 'exportSettings', 'textPath', 'pathOffset', 'connector', 'board', 'maskType'])
const fields = {
  vectorGeometry,
  vectorBrush: describe(obj({source: network, mode: en('stretch','scatter'), width: num(.001,10000), spacing: num(.001,1e7), seed: integer(0,4294967295), rotation: num(-Math.PI*2,Math.PI*2), rotationVariance: num(0,Math.PI*2), scaleVariance: num(0,.99), scatter: num(0,10000), followTangent: bool}, ['source','mode','width','spacing','seed','rotation','rotationVariance','scaleVariance','scatter','followTangent']), 'Editable embedded single closed nonzero-fill source; vector guide also nonzero. Stretch admits straight forward-only guides; Scatter preserves source Beziers with bounded arc-length placement. 4096 input edges/vertices and stamps, 100000 output commands. No holes or multicolor sources.'),
  repeat: describe(obj({ count: integer(1, 256), translation: point, pivot: point, rotation: num(-Math.PI*200, Math.PI*200), scale: obj({ x: num(0.01,100), y: num(0.01,100) }, ['x','y']) }, ['count','translation','pivot','rotation','scale']), 'Non-destructive total count including source; translation and pivot in parent coordinates, rotation in radians, positive per-step scales. Bounded derived scene: 16384 nodes / 16 MiB.'),
  name: str(), transform: nodeTransformSchema,
  width: describe(num(1e-6), 'Local width. Minimum 0.01 for most kinds; line/vector allow 0.000001. Maximum 10000000.'),
  height: describe(num(1e-6), 'Local height. Minimum 0.01 for most kinds; line/vector allow 0.000001. Maximum 10000000.'),
  visible: bool, locked: bool, opacity: unit, blend: en(...blendModes, 'pass-through'), fills: array(paint, 16), strokes: array(stroke, 16), effects: array(effect, 16), radii: tuple(num(0), 4), smoothing: unit, clip: bool, mask: bool, maskType: en('alpha', 'luminance', 'outline', 'shape'),
  points: describe(num(0, 128), 'Polygon/star require at least 3; other kinds allow 0.'), innerRadius: describe(unit, 'Star requires at least 0.01; other kinds allow 0.'), network,
  text: str(100000), fontSize: num(1, 4096), textStyle,
  textRuns: describe(array(obj({ start: integer(0, 100000), end: integer(0, 100000), fontId: id, fontSize: num(1, 4096), weight: num(1, 1000), paragraph: textParagraph, color, underline: bool, strikethrough: bool, link: describe(str(4096), 'http://, https:// or mailto: URL.'), textCase, letterSpacing: describe(num(-1000, 1000), 'Extra design pixels after each cluster in this run. Requires schema 21.'), lineHeight: describe(num(0.1, 10), 'Line-box multiplier of this run font size. Requires schema 21.') }, ['start', 'end']), 4096), 'Ordered nonoverlapping [start,end) UTF-16 intervals on complete grapheme boundaries of the node text; start must be less than end. letterSpacing and lineHeight require schema 21.'),
  layout: describe(obj({ mode: en('none', 'horizontal', 'vertical', 'grid'), gap: num(0, 1e5), lineGap: num(0, 1e5), padding: tuple(num(0, 1e5), 4), wrap: bool, justify: en('start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly', 'unsafe-center', 'unsafe-end'), align: en('start','center','end','stretch','unsafe-center','unsafe-end'), columns: integer(1, 64), fillRows: bool }), 'Containers only. Omitted fields use native defaults.'),
  sizing: describe(obj({ width: en('fixed', 'hug', 'fill'), height: en('fixed', 'hug', 'fill'), minWidth: num(0.01), minHeight: num(0.01), maxWidth: num(0.01), maxHeight: num(0.01), absolute: bool, alignSelf: nullable(align), columnSpan: integer(1, 64), rowSpan: integer(1, 64) }), 'Maxima must be >= minima. Hug requires text or active auto-layout. Omitted fields use native defaults.'),
  constraints: obj({ horizontal: en('start', 'center', 'end', 'stretch', 'scale'), vertical: en('start', 'center', 'end', 'stretch', 'scale'), referenceWidth: nullable(num(0.01)), referenceHeight: nullable(num(0.01)) }),
  layoutGrid: describe(obj({ axis: en('column', 'row', 'uniform'), count: integer(1, 64), gutter: num(0), margin: num(0), color, visible: bool, opacity: unit }), 'Frames only; omitted fields use native defaults.'),
  guides: describe(array(obj({ id, axis: en('x', 'y'), position: num() }, ['id', 'axis', 'position']), 1000), 'Frame/section only for nonempty lists; IDs unique per owner; document total <=20000.'),
  arc: describe(obj({ startAngle: num(), sweepAngle: num(-2 * Math.PI, 2 * Math.PI), innerRadius: unit }, ['startAngle', 'sweepAngle', 'innerRadius']), 'Ellipse without an explicit network; angles in radians.'),
  cornerRadius: describe(num(0), 'Nonzero only on polygon/star without an explicit network.'), constrainProportions: bool, booleanOperation: en('union', 'subtract', 'intersect', 'exclude', 'compoundNonzero', 'compoundEvenodd'),
  exportSettings: describe(array(obj({ id, format: en('png', 'svg', 'jpeg', 'webp', 'pdf', 'pdf-vector', 'tiff'), scale: num(0.001, 128), suffix: describe(str(80), 'No control characters or \\ / : * ? " < > |.') }, ['id', 'format', 'scale', 'suffix']), 16), 'IDs must be unique.'),
  textPath: describe(obj({ network, offset: num(), normal: num(), reverse: bool }, ['network']), 'Text nodes only; one continuous nonempty path, at most 10000 edges.'),
  pathOffset: describe(num(-10000, 10000), 'Nonzero unsupported on text/frame/section/group/slice.'),
  connector: describe(obj({ from: endpoint, to: endpoint, style: en('straight', 'elbow') }, ['from', 'to', 'style']), 'Vector nodes only. Attached endpoints require an anchor and an existing nonslice/nonconnector target other than self.'),
  board: describe(obj({ kind: en('sticky', 'table', 'code-block', 'shape-whiteboard-square', 'shape-whiteboard-ellipse', 'shape-whiteboard-rounded-rectangle', 'shape-whiteboard-triangle-up', 'shape-whiteboard-triangle-down', 'shape-whiteboard-diamond', 'sites-responsive-set'), rows: integer(0, 4294967295), columns: integer(0, 4294967295), language: en('plain', 'javascript', 'typescript', 'rust', 'python', 'json') }, ['kind']), 'Table requires rows 1–50 and columns 1–30 with product <=600.'),
} satisfies Partial<Record<keyof DesignNode, Schema>>
export const NODE_FIELDS = new Set<string>(Object.keys(fields))
export const nodePatchSchema = describe(obj(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, OPTIONAL_NODE_FIELDS.has(key) ? describe(nullable(value), 'Null removes this optional property. ' + String(value.description ?? '')) : value]))), 'Whole-property replacements of native authored fields only. Identity, child structure and design-system/custom metadata use dedicated operations. Kind, document schema version, references and cross-field invariants are checked at commit. All requests remain subject to JSON structural and byte budgets.')
