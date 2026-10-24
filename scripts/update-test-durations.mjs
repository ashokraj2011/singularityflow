#!/usr/bin/env node
/**
 * Fold a run's measured test-file times into the committed timing profile that balances shards.
 *
 *   node scripts/update-test-durations.mjs <run directory or durations.json>...
 *
 * The aggregate runner writes <run directory>/durations.json. Files a run measured replace their
 * old entries, files it did not run keep theirs, and files that no longer exist are dropped. The
 * profile only schedules shards (scripts/test-suite-plan.mjs); it never changes what runs.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_DURATIONS_PATH } from './test-suite-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('Use: node scripts/update-test-durations.mjs <run directory or durations.json>...');
  process.exit(2);
}
const target = path.join(root, TEST_DURATIONS_PATH);
const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const files = { ...(read(target)?.files ?? {}) };
let measured = 0;
for (const input of inputs) {
  const file = existsSync(input) && statSync(input).isDirectory() ? path.join(input, 'durations.json') : input;
  const run = read(file);
  if (run?.schemaVersion !== 1 || !run.files) throw new Error(`${file} is not a test duration file.`);
  for (const [relative, ms] of Object.entries(run.files)) {
    if (Number.isFinite(ms) && ms > 0) { files[relative] = Math.round(ms); measured += 1; }
  }
}
for (const relative of Object.keys(files)) if (!existsSync(path.join(root, relative))) delete files[relative];
const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, unit: 'ms', files: sorted }, null, 2)}\n`);
console.log(`Wrote ${TEST_DURATIONS_PATH}: ${Object.keys(sorted).length} files, ${measured} measured in this update.`);
