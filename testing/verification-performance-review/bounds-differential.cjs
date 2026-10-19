const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '../..');
const { stripTypeScriptTypes } = require('node:module');
const geometryPath = path.join(root, 'frontend/design-client/src/geometry.ts');
const geometryText = fs.readFileSync(geometryPath, 'utf8');
const needed = new Set(['boxPoints', 'bounds', 'unionBounds']);
const geometryStart = geometryText.indexOf('export const boxPoints =');
const geometryEnd = geometryText.indexOf('export const intersects =', geometryStart);
assert.ok(geometryStart > 0 && geometryEnd > geometryStart);
const geometryParts = geometryText.slice(geometryStart, geometryEnd);
function compile(text, required = {}) {
  const names = [...text.matchAll(/export (?:function|const) (\w+)/g)].map(match => match[1]);
  const output = stripTypeScriptTypes(text, { mode: 'strip' })
    .replace(/import \{[^}]+\} from ['"]([^'"]+)['"]/g, (_, name) => {
      assert.ok(name in required, `Unexpected import: ${name}`);
      return `const { unionBounds } = required[${JSON.stringify(name)}]`;
    }).replace(/export (function|const) /g, '$1 ');
  const exports = {};
  vm.runInNewContext(output + '\n' + names.map(name => `exports.${name} = ${name};`).join('\n'), { exports, required });
  return exports;
}
const geometry = compile(geometryParts);
assert.deepEqual(Object.keys(geometry).sort(), [...needed].sort());
const frozen = fs.readFileSync(path.join(__dirname, 'fixtures/interaction-renderer.before.ts'), 'utf8');
const begin = frozen.indexOf('        this.resident.rootBounds = new Map(');
const end = frozen.indexOf('        // Small nested edits', begin);
assert.ok(begin > 0 && end > begin);
const expression = frozen.slice(begin, end).trim().replace('this.resident.rootBounds = ', 'return ').replaceAll('props.document', 'document');
const before = new Function('document', 'pageId', 'entries', 'unionBounds', expression);
const helperPath = path.join(root, 'frontend/design-client/src/kernel/interaction-scene-bounds.ts');
const helperText = fs.readFileSync(helperPath, 'utf8');
const after = compile(helperText, { '../geometry': geometry }).interactionRootBounds;
const mutantText = helperText.replace('const pad = Math.max(0,', 'const pad = 0 * Math.max(0,');
assert.notEqual(mutantText, helperText);
const mutant = compile(mutantText, { '../geometry': geometry }).interactionRootBounds;
let seed = 0x35bde10;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2**32 };
const pick = array => array[Math.floor(random() * array.length)];
const number = () => pick([0, -0, .125, -.375, 1e-12, -1e-12, 99999.75, -50000.5, random() * 2000 - 1000]);
let cases = 0, entriesTested = 0, mutantFailures = 0;
for (let index = 0; index < 2500; index++) {
  const ids = Array.from({ length: 1 + Math.floor(random() * 20) }, (_, i) => `n${i}`);
  const roots = ids.filter(() => random() < .5);
  if (index % 5 === 0) roots.push('hidden-root');
  if (index % 7 === 0 && roots.length) roots.push(roots[0]);
  const document = { pages: [{ id: 'p', children: roots }], nodes: {} };
  const entries = ids.map((id, i) => {
    document.nodes[id] = {
      effects: Array.from({ length: Math.floor(random() * 4) }, () => ({ visible: random() < .7, radius: Math.abs(number()), x: number(), y: number(), spread: number() })),
      strokes: Array.from({ length: Math.floor(random() * 3) }, () => ({ visible: random() < .7, width: Math.abs(number()) })),
    };
    return { id, ancestors: i && random() < .6 ? [pick(ids.slice(0, i))] : [],
      matrix: [number(), number(), number(), number(), number(), number()],
      bounds: { x: number(), y: number(), width: Math.abs(number()), height: Math.abs(number()) } };
  });
  const pageId = index % 17 === 0 ? 'missing' : 'p';
  const a = before(document, pageId, entries, geometry.unionBounds), b = after(document, pageId, entries);
  // Compare scalar values with Object.is; VM realms deliberately differ.
  const exact = (x, y) => [...x.keys()].join('|') === [...y.keys()].join('|') && [...x].every(([id, v]) =>
    ['x','y','width','height'].every(key => Object.is(v[key], y.get(id)[key])));
  assert.ok(exact(a, b), `Exact bounds mismatch in seeded fixture ${index}`);
  if (!exact(a, mutant(document, pageId, entries))) mutantFailures++;
  cases++; entriesTested += entries.length;
}
assert.ok(mutantFailures > 1000, 'Dropped-padding negative control must fail substantial nonempty fixtures');
console.log(JSON.stringify({ status: 'passed', sourceSha256: crypto.createHash('sha256').update(helperText).digest('hex'), cases, entriesTested, exact: 'Object.is all x/y/width/height and Map key order', negativeControl: { mutation: 'drop all effect/stroke padding', failures: mutantFailures }, scope: 'Actual TypeScript helper + actual production union functions, frozen old renderer expression; CPU differential only, not browser/GPU pixels' }, null, 2));
