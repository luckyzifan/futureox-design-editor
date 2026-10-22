// Replay existing scalar diagnostic records only. This is a CPU microbenchmark,
// not an editor, GPU, frame-rate or input-to-pixel latency measurement.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const [ref, output, ...logs] = process.argv.slice(2);
if (!ref || !output || !logs.length) throw Error('Expected BASE_COMMIT OUTPUT_JSON LOG...');
const sourcePath = 'frontend/design-desktop/src/render-terminal-diagnostics.mjs';
const oldSource = execFileSync('git', ['show', `${ref}:${sourcePath}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
const newSource = await readFile(sourcePath, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const before = await load(oldSource), after = await load(newSource), records = [], inputs = [];
for (const file of logs) {
  const raw = await readFile(file); inputs.push({ sha256: hash(raw), bytes: raw.length });
  for (const line of raw.toString('utf8').split('\n')) {
    const at = line.indexOf('[render-diag] '); if (at < 0) continue;
    const record = JSON.parse(line.slice(at + '[render-diag] '.length));
    if (Array.isArray(record.batch)) records.push(...record.batch); else records.push(record);
  }
}
if (!records.length) throw Error('No actual scalar records found');
for (const record of records) if (JSON.stringify(before.sanitizeRecord(record)) !== JSON.stringify(after.sanitizeRecord(record)))
  throw Error('Validation output changed for a replayed record');
const run = module => { const start = performance.now(); let retained = 0;
  for (const record of records) retained += Number(module.sanitizeRecord(record) !== null);
  return { milliseconds: performance.now() - start, retained }; };
run(before); run(after); const timings = [];
for (let iteration = 0; iteration < 5; iteration++) {
  const modules = iteration % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]];
  for (const [kind, module] of modules) timings.push({ iteration, kind, ...run(module) });
}
const report = { scope: 'CPU-only replay of existing numeric diagnostic records. No render workload or GPU timing comparison.',
  node: process.version, beforeSourceSha256: hash(oldSource), afterSourceSha256: hash(newSource), inputs,
  records: records.length, validationOutputsEqual: true, timings };
await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
