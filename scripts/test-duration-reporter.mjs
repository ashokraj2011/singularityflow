/**
 * A node:test reporter that writes the measured time of each test file's top-level tests as JSON:
 * { schemaVersion: 1, files: { "test/x.test.mjs": ms } }. The suite runner adds it beside the TAP
 * reporter, and scripts/update-test-durations.mjs turns a run's files into the committed timing
 * profile that balances shards (scripts/test-suite-plan.mjs).
 */
import path from 'node:path';

export default async function* testDurations(source) {
  const files = {};
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, nesting, name, details } = event.data ?? {};
    // A file that fails to load is reported as a test named after the file; its tests are what count.
    if (!file || nesting !== 0 || name === file || /\.test\.(?:mjs|cjs|js)$/u.test(String(name))) continue;
    const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
    files[relative] = (files[relative] ?? 0) + Math.max(0, Number(details?.duration_ms) || 0);
  }
  yield `${JSON.stringify({ schemaVersion: 1, files: Object.fromEntries(Object.entries(files).map(([key, ms]) => [key, Math.round(ms)])) })}\n`;
}
