/** Balanced A/B runs: avoid attributing a changing host load to the engine run second. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = option('baseline-engine');
const candidate = path.resolve(option('engine') ?? root);
const samples = Number(option('samples') ?? 6);
const profile = option('profile') ?? 'both';
const runtime = option('runtime') ?? 'bundle';
if (!baseline) throw new Error('Supply --baseline-engine=/path/to/baseline.');
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 10 || samples % 2) {
  throw new Error('Use an even sample count from 2 to 10 for balanced before/after order.');
}
if (!['small', 'large', 'both'].includes(profile) || !['bundle', 'source'].includes(runtime)) {
  throw new Error('Select profile small/large/both and runtime bundle/source.');
}
const engines = { before: path.resolve(baseline), after: candidate };
const profiles = profile === 'both' ? ['small', 'large'] : [profile];
const rows = [];
for (const selected of profiles) {
  for (let sample = 0; sample < samples; sample++) {
    const order = sample % 2 ? ['after', 'before'] : ['before', 'after'];
    for (const variant of order) {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/source-review-benchmark.mjs'),
        `--engine=${engines[variant]}`, `--runtime=${runtime}`, '--samples=1',
        `--history=${selected === 'small' ? 0 : 100}`, `--attachments=${selected === 'small' ? 0 : 16}`], {
        cwd: root, env: process.env, encoding: 'utf8', timeout: 600_000, maxBuffer: 40 * 1024 * 1024
      });
      assert.equal(result.status, 0, `${selected}/${sample}/${variant}: ${result.stderr}\n${result.stdout}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.runtime, runtime);
      assert.equal(report.samples, 1);
      rows.push(...report.rows.map(row => ({ ...row, profile: selected, sample, variant, order: order.indexOf(variant) })));
    }
  }
}
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const sequence = new Set(['context-cold', 'stage', 'check', 'retain', 'status-cold']);
const summary = profiles.map(selected => Object.fromEntries(['profile', 'before', 'after'].map(key => {
  if (key === 'profile') return [key, selected];
  const selectedRows = rows.filter(row => row.profile === selected && row.variant === key);
  return [key, { sequenceMs: median(Array.from({ length: samples }, (_, sample) =>
    selectedRows.filter(row => row.sample === sample && sequence.has(row.action)).reduce((sum, row) => sum + row.ms, 0))),
    coldContextMs: median(selectedRows.filter(row => row.action === 'context-cold').map(row => row.ms)),
    steps: Object.fromEntries([...new Set(selectedRows.map(row => row.action))].map(action => [action,
      median(selectedRows.filter(row => row.action === action).map(row => row.ms))])) }];
})));
const report = { platform: process.platform, node: process.version, runtime, samples, engines,
  scope: 'Alternating A/B then B/A disposable Story pairs. Each engine uses an isolated empty V8 compile cache for first context; warm context repeats it. OS caches are not flushed. Excludes model, shell transport and network push.',
  summary, rows };
if (option('output')) await writeFile(path.resolve(option('output')), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ platform: report.platform, node: report.node, runtime, samples, summary }, null, 2));
