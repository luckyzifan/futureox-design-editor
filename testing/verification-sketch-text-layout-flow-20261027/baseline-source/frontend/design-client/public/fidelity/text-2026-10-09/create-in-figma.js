// Creates the seven text comparison frames of text-2026-10-09 in Figma.
// Run inside the Figma plugin console (or MCP) with the calibration file open.
// Font: Noto Sans SC Regular (Figma cloud font). After creation, export every
// "KernelTextQA-*" frame as PNG scale 1 with sRGB and save next to cases.json
// using the case ids as file names.
const cases = [
  {id:'text-latin-basic', nodes:[
    {id:'t', kind:'text', x:24, y:24, w:270, h:60, size:28, characters:'Handgloves 0123 &?'}]},
  {id:'text-fractional-position', nodes:[
    {id:'t', kind:'text', x:40.375, y:64.625, w:240, h:60, size:26, characters:'Fractional xyz'}]},
  {id:'text-sizes', nodes:[
    {id:'s1', kind:'text', x:16, y:14, w:200, h:26, size:12, characters:'Size 12'},
    {id:'s2', kind:'text', x:16, y:52, w:240, h:60, size:30.5, characters:'Size 30.5'},
    {id:'s3', kind:'text', x:16, y:124, w:280, h:100, size:64, characters:'Size 64'}]},
  {id:'text-cjk-mixed', nodes:[
    {id:'c1', kind:'text', x:20, y:20, w:280, h:50, size:24, characters:'中英混排 Mixed 測試'},
    {id:'c2', kind:'text', x:20, y:90, w:280, h:44, size:20, characters:'——「引用」42°±0.5'}]},
  {id:'text-multiline', nodes:[
    {id:'m1', kind:'text', x:20, y:16, w:280, h:110, size:18, characters:'First line\nSecond line\n第三行 here', lineHeight:140}]},
  {id:'text-letter-spacing', nodes:[
    {id:'l1', kind:'text', x:20, y:24, w:280, h:50, size:22, characters:'Tracked reading', letterSpacing:2.5},
    {id:'l2', kind:'text', x:20, y:120, w:280, h:50, size:22, characters:'Tight run', letterSpacing:-0.75}]},
  {id:'text-styled-runs', nodes:[
    {id:'r1', kind:'text', x:20, y:60, w:300, h:90, size:24, characters:'BigRed small rest',
     runs:[{start:0, end:6, size:30, color:'#c0392b'}, {start:6, end:17, size:18}]}]},
];
const pageName = 'Kernel text comparison 2026-10-09';
const hex = h => ({r:parseInt(h.slice(1,3),16)/255, g:parseInt(h.slice(3,5),16)/255, b:parseInt(h.slice(5,7),16)/255});
let page = figma.root.children.find(p => p.name === pageName);
const made = [];
if (!page) { page = figma.createPage(); page.name = pageName; made.push(page.id); }
await figma.setCurrentPageAsync(page);
let board = page.children.find(n => n.name === 'Kernel text versus Figma');
if (!board) {
  board = figma.createFrame();
  page.appendChild(board);
  board.name = 'Kernel text versus Figma';
  board.resize(1600, 640);
  board.fills = [];
  board.clipsContent = false;
  board.x = 96; board.y = 96;
  made.push(board.id);
}
await figma.loadFontAsync({ family: 'Noto Sans SC', style: 'Regular' });
const font = { family: 'Noto Sans SC', style: 'Regular' };
const result = [];
for (const item of cases) {
  const name = 'KernelTextQA-' + item.id;
  let frame = board.children.find(n => n.name === name);
  if (!frame) {
    frame = figma.createFrame();
    board.appendChild(frame);
    frame.name = name;
    frame.resize(320, 240);
    frame.fills = [{ type: 'SOLID', color: hex('#ffffff') }];
    frame.strokes = [];
    frame.clipsContent = true;
    frame.x = (result.length % 4) * 352 + 16;
    frame.y = Math.floor(result.length / 4) * 264 + 16;
    frame.exportSettings = [{ format: 'PNG', constraint: { type: 'SCALE', value: 1 }, colorProfile: 'SRGB', contentsOnly: true }];
    made.push(frame.id);
    for (const spec of item.nodes) {
      const n = figma.createText();
      frame.appendChild(n);
      made.push(n.id);
      n.name = spec.id;
      n.fontName = font;
      n.characters = spec.characters;
      n.fontSize = spec.size;
      n.fills = [{ type: 'SOLID', color: hex('#222438') }];
      n.textAutoResize = 'NONE';
      n.textAlignHorizontal = 'LEFT';
      n.textAlignVertical = 'TOP';
      n.resize(spec.w, spec.h);
      n.x = spec.x; n.y = spec.y;
      if (spec.lineHeight) n.lineHeight = { value: spec.lineHeight, unit: 'PERCENT' };
      if (spec.letterSpacing !== undefined) n.letterSpacing = { value: spec.letterSpacing, unit: 'PIXELS' };
      if (spec.runs) {
        for (const run of spec.runs) {
          n.setRangeFontSize(run.start, run.end, run.size);
          if (run.color) n.setRangeFills(run.start, run.end, [{ type: 'SOLID', color: hex(run.color) }]);
        }
      }
    }
  }
  result.push({ case: item.id, nodeId: frame.id, name: frame.name, width: frame.width, height: frame.height });
}
figma.currentPage.selection = board.children.slice();
figma.viewport.scrollAndZoomIntoView([board]);
return { createdNodeIds: made, pageId: page.id, boardId: board.id, frames: result, font };
