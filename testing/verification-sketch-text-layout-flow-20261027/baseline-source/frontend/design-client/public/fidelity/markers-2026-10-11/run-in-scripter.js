// Scripter variant of create-in-figma.js: creates the calibration boards in the
// current file, then exports every frame via exportAsync and POSTs the PNGs
// (base64) plus a readback JSON to a local receiver at 127.0.0.1:8971.
// Start the receiver first: python3 /tmp/figma-export-receiver.py
// Paste into the "Scripter" community plugin and run once.

const RECEIVER = 'http://127.0.0.1:8971';

const markerTypes = ['ARROW_LINES', 'ARROW_EQUILATERAL', 'TRIANGLE_FILLED', 'DIAMOND_FILLED', 'CIRCLE_FILLED'];
const weights = [1, 2, 2.5, 3, 4, 6, 8, 12, 16, 24];

const pageName = 'Kernel marker calibration 2026-10-11';
const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const black = hex('#000000');

function b64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
async function post(name, bytes) {
  const res = await fetch(`${RECEIVER}/${encodeURIComponent(name)}`, { method: 'POST', body: b64(bytes) });
  return res.status;
}
async function exportAndPost(node, baseName, scale) {
  const bytes = await node.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: scale },
    colorProfile: 'SRGB',
    contentsOnly: true,
  });
  const suffix = scale === 1 ? '' : `@${scale}x`;
  return post(`${baseName}${suffix}.png`, bytes);
}

const run = async () => {
  let page = figma.root.children.find(p => p.name === pageName);
  const made = [];
  if (!page) { page = figma.createPage(); page.name = pageName; made.push(page.id); }
  await figma.setCurrentPageAsync(page);

  function frameAt(board, name, x, y, w, h) {
    let f = board.children.find(n => n.name === name);
    if (!f) { f = figma.createFrame(); board.appendChild(f); f.name = name; made.push(f.id); }
    f.resize(w, h);
    f.fills = [{ type: 'SOLID', color: hex('#ffffff') }];
    f.strokes = [];
    f.clipsContent = true;
    f.x = x; f.y = y;
    return f;
  }

  let board = page.children.find(n => n.name === 'Kernel markers versus Figma');
  if (!board) { board = figma.createFrame(); page.appendChild(board); board.name = 'Kernel markers versus Figma'; made.push(board.id); }
  board.fills = []; board.clipsContent = false;

  const cols = 5, cellW = 352, cellH = 144;
  const result = [];
  const seen = new Set(board.children.map(c => c.name));
  for (const type of markerTypes) {
    for (const w of weights) {
      const id = `${type}-w${String(w).replace('.', 'p')}`;
      const name = `KernelMarkerQA-${id}`;
      if (seen.has(name)) continue;
      const f = frameAt(board, name, (result.length % cols) * cellW + 16, Math.floor(result.length / cols) * cellH + 16, 320, 112);
      const line = figma.createLine();
      f.appendChild(line); made.push(line.id);
      line.name = 'l'; line.x = 40; line.y = 56; line.resize(240, 0);
      line.strokes = [{ type: 'SOLID', color: black }];
      line.strokeWeight = w; line.strokeAlign = 'CENTER'; line.strokeCap = type;
      result.push({ case: id, nodeId: f.id, lineId: line.id, type, weight: w });
    }
  }
  {
    const name = 'KernelMarkerQA-NONE-w4';
    if (!seen.has(name)) {
      const f = frameAt(board, name, (result.length % cols) * cellW + 16, Math.floor(result.length / cols) * cellH + 16, 320, 112);
      const line = figma.createLine();
      f.appendChild(line); made.push(line.id);
      line.name = 'l'; line.x = 40; line.y = 56; line.resize(240, 0);
      line.strokes = [{ type: 'SOLID', color: black }];
      line.strokeWeight = 4; line.strokeAlign = 'CENTER'; line.strokeCap = 'NONE';
      result.push({ case: 'NONE-w4', nodeId: f.id, lineId: line.id, type: 'NONE', weight: 4 });
    }
  }
  board.resize(cols * cellW + 16, Math.ceil(result.length / cols) * cellH + 16);

  let blurBoard = page.children.find(n => n.name === 'Kernel blur noise probes');
  if (!blurBoard) { blurBoard = figma.createFrame(); page.appendChild(blurBoard); blurBoard.name = 'Kernel blur noise probes'; made.push(blurBoard.id); }
  blurBoard.fills = []; blurBoard.clipsContent = false;
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
    if (c.kind === 'LAYER_BLUR') {
      const rect = figma.createRectangle();
      f.appendChild(rect); made.push(rect.id);
      rect.name = 'r'; rect.x = 20; rect.y = 20; rect.resize(600, 472);
      rect.fills = [{ type: 'SOLID', color: hex('#202020') }];
      rect.effects = [{ type: 'LAYER_BLUR', radius: c.radius, visible: true, blendMode: 'NORMAL' }];
    } else {
      const bg = figma.createRectangle();
      f.appendChild(bg); made.push(bg.id);
      bg.name = 'bg'; bg.x = 0; bg.y = 0; bg.resize(640, 512);
      bg.fills = [{ type: 'GRADIENT_LINEAR', gradientStops: [
        { position: 0, color: { ...hex('#d02020'), a: 1 } },
        { position: 1, color: { ...hex('#f0f040'), a: 1 } },
      ], gradientTransform: [[1, 0, 0], [0, 1, 0]] }];
      const veil = figma.createRectangle();
      f.appendChild(veil); made.push(veil.id);
      veil.name = 'veil'; veil.x = 20; veil.y = 20; veil.resize(600, 472);
      veil.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.35 } }];
      veil.effects = [{ type: 'BACKGROUND_BLUR', radius: c.radius, visible: true }];
    }
    blurResult.push({ case: c.id, nodeId: f.id, kind: c.kind, radius: c.radius });
  }
  blurBoard.resize(680, blurCases.length * 528 + 16);

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
  await post('readback.json', new TextEncoder().encode(JSON.stringify({ markers: result, blur: blurResult, readback }, null, 2)));

  const uploads = [];
  for (const r of result) {
    const node = await figma.getNodeByIdAsync(r.nodeId);
    uploads.push(await exportAndPost(node, 'KernelMarkerQA-' + r.case, 1));
    uploads.push(await exportAndPost(node, 'KernelMarkerQA-' + r.case, 4));
  }
  for (const r of blurResult) {
    const node = await figma.getNodeByIdAsync(r.nodeId);
    uploads.push(await exportAndPost(node, 'KernelBlurQA-' + r.case, 1));
  }

  figma.viewport.scrollAndZoomIntoView([board, blurBoard]);
  return { created: made.length, exported: uploads.length, statuses: [...new Set(uploads)] };
};
run();
