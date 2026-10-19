// Creates the stroke endpoint-marker calibration board of markers-2026-10-11
// in Figma. Run inside the Figma plugin console (or MCP) with any file open.
//
// Board A — one frame per (marker type × stroke weight): a single horizontal
// black line on white, strokeCap applied to both ends. Geometry constants for
// stroke/markers.rs are derived from the exported PNGs plus the
// absoluteRenderBounds readback returned by this script.
//
// Board B — large layer/background blur probes (>512px) to test whether
// Figma's export path injects the 256px-periodic noise that Bjango measured
// in-app; the existing BlurQA corpus is 128x128 and cannot show one period.
//
// After creation export every "KernelMarkerQA-*" / "KernelBlurQA-*" frame as
// PNG scale 1 (markers also have a 4x preset with suffix @4x), sRGB, and save
// next to this file using the case ids as file names.
//
// Figma-side enum (plugin-typings, verified 2026-10-11):
//   StrokeCap = NONE|ROUND|SQUARE|ARROW_LINES|ARROW_EQUILATERAL|
//               DIAMOND_FILLED|TRIANGLE_FILLED|CIRCLE_FILLED
// There is no SQUARE_FILLED and no BAR in the official union; Forma's square
// and bar markers are product additions and must not be calibrated here.

const markerTypes = [
  'ARROW_LINES',
  'ARROW_EQUILATERAL',
  'TRIANGLE_FILLED',
  'DIAMOND_FILLED',
  'CIRCLE_FILLED',
];
const weights = [1, 2, 2.5, 3, 4, 6, 8, 12, 16, 24];

const pageName = 'Kernel marker calibration 2026-10-11';
const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const black = hex('#000000');

let page = figma.root.children.find(p => p.name === pageName);
const made = [];
if (!page) { page = figma.createPage(); page.name = pageName; made.push(page.id); }
await figma.setCurrentPageAsync(page);

function frameAt(board, name, x, y, w, h) {
  let f = board.children.find(n => n.name === name);
  if (!f) {
    f = figma.createFrame();
    board.appendChild(f);
    f.name = name;
    made.push(f.id);
  }
  f.resize(w, h);
  f.fills = [{ type: 'SOLID', color: hex('#ffffff') }];
  f.strokes = [];
  f.clipsContent = true;
  f.x = x; f.y = y;
  return f;
}

// ---- Board A: marker geometry ----
let board = page.children.find(n => n.name === 'Kernel markers versus Figma');
if (!board) {
  board = figma.createFrame();
  page.appendChild(board);
  board.name = 'Kernel markers versus Figma';
  made.push(board.id);
}
board.fills = [];
board.clipsContent = false;

const cols = 5;
const cellW = 352, cellH = 144;
const result = [];
const seen = new Set(board.children.map(c => c.name));
for (const type of markerTypes) {
  for (const w of weights) {
    const id = `${type}-w${String(w).replace('.', 'p')}`;
    const name = `KernelMarkerQA-${id}`;
    if (seen.has(name)) continue;
    const f = frameAt(board, name, (result.length % cols) * cellW + 16, Math.floor(result.length / cols) * cellH + 16, 320, 112);
    f.exportSettings = [
      { format: 'PNG', constraint: { type: 'SCALE', value: 1 }, colorProfile: 'SRGB', contentsOnly: true },
      { format: 'PNG', constraint: { type: 'SCALE', value: 4 }, suffix: '@4x', colorProfile: 'SRGB', contentsOnly: true },
    ];
    const line = figma.createLine();
    f.appendChild(line);
    made.push(line.id);
    line.name = 'l';
    line.x = 40; line.y = 56;
    line.resize(240, 0);
    line.strokes = [{ type: 'SOLID', color: black }];
    line.strokeWeight = w;
    line.strokeAlign = 'CENTER';
    line.strokeCap = type;
    result.push({ case: id, nodeId: f.id, lineId: line.id, type, weight: w });
  }
}
// butt-cap baseline (marker = NONE) for extent subtraction
{
  const name = 'KernelMarkerQA-NONE-w4';
  if (!seen.has(name)) {
    const f = frameAt(board, name, (result.length % cols) * cellW + 16, Math.floor(result.length / cols) * cellH + 16, 320, 112);
    f.exportSettings = [
      { format: 'PNG', constraint: { type: 'SCALE', value: 1 }, colorProfile: 'SRGB', contentsOnly: true },
      { format: 'PNG', constraint: { type: 'SCALE', value: 4 }, suffix: '@4x', colorProfile: 'SRGB', contentsOnly: true },
    ];
    const line = figma.createLine();
    f.appendChild(line);
    made.push(line.id);
    line.name = 'l';
    line.x = 40; line.y = 56;
    line.resize(240, 0);
    line.strokes = [{ type: 'SOLID', color: black }];
    line.strokeWeight = 4;
    line.strokeAlign = 'CENTER';
    line.strokeCap = 'NONE';
    result.push({ case: 'NONE-w4', nodeId: f.id, lineId: line.id, type: 'NONE', weight: 4 });
  }
}
board.resize(cols * cellW + 16, Math.ceil(result.length / cols) * cellH + 16);

// ---- Board B: large blur probes ----
let blurBoard = page.children.find(n => n.name === 'Kernel blur noise probes');
if (!blurBoard) {
  blurBoard = figma.createFrame();
  page.appendChild(blurBoard);
  blurBoard.name = 'Kernel blur noise probes';
  blurBoard.fills = [];
  blurBoard.clipsContent = false;
  made.push(blurBoard.id);
}
const blurCases = [
  { id: 'layer-blur-8', kind: 'LAYER_BLUR', radius: 8 },
  { id: 'layer-blur-24', kind: 'LAYER_BLUR', radius: 24 },
  { id: 'background-blur-8', kind: 'BACKGROUND_BLUR', radius: 8 },
];
const blurResult = [];
const seenBlur = new Set(blurBoard.children.map(c => c.name));
for (let i = 0; i < blurCases.length; i++) {
  const c = blurCases[i];
  const name = `KernelBlurQA-${c.id}`;
  if (seenBlur.has(name)) continue;
  const f = frameAt(blurBoard, name, 16, i * 528 + 16, 640, 512);
  f.exportSettings = [{ format: 'PNG', constraint: { type: 'SCALE', value: 1 }, colorProfile: 'SRGB', contentsOnly: true }];
  if (c.kind === 'LAYER_BLUR') {
    const rect = figma.createRectangle();
    f.appendChild(rect);
    made.push(rect.id);
    rect.name = 'r';
    rect.x = 20; rect.y = 20;
    rect.resize(600, 472);
    rect.fills = [{ type: 'SOLID', color: hex('#202020') }];
    rect.effects = [{ type: 'LAYER_BLUR', radius: c.radius, visible: true, blendMode: 'NORMAL' }];
  } else {
    const bg = figma.createRectangle();
    f.appendChild(bg);
    made.push(bg.id);
    bg.name = 'bg';
    bg.x = 0; bg.y = 0;
    bg.resize(640, 512);
    bg.fills = [{ type: 'GRADIENT_LINEAR', gradientStops: [
      { position: 0, color: { ...hex('#d02020'), a: 1 } },
      { position: 1, color: { ...hex('#f0f040'), a: 1 } },
    ], gradientTransform: [[1, 0, 0], [0, 1, 0]] }];
    const veil = figma.createRectangle();
    f.appendChild(veil);
    made.push(veil.id);
    veil.name = 'veil';
    veil.x = 20; veil.y = 20;
    veil.resize(600, 472);
    veil.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.35 } }];
    veil.effects = [{ type: 'BACKGROUND_BLUR', radius: c.radius, visible: true }];
  }
  blurResult.push({ case: c.id, nodeId: f.id, kind: c.kind, radius: c.radius });
}
blurBoard.resize(680, blurCases.length * 528 + 16);

// ---- readback: parameters + render bounds (marker extents without PNGs) ----
const readback = [];
for (const r of result) {
  const node = await figma.getNodeByIdAsync(r.lineId);
  const bounds = node.absoluteRenderBounds;
  const box = node.absoluteBoundingBox;
  readback.push({
    case: r.case, type: r.type, weight: r.weight,
    strokeCap: node.strokeCap, strokeWeight: node.strokeWeight,
    bbox: box && { x: box.x, y: box.y, w: box.width, h: box.height },
    renderBounds: bounds && { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
  });
}

figma.currentPage.selection = [board, blurBoard];
figma.viewport.scrollAndZoomIntoView([board, blurBoard]);
return { createdNodeIds: made, pageId: page.id, markersBoardId: board.id, blurBoardId: blurBoard.id, markers: result, blur: blurResult, readback };
