/** Native node:test events alongside TAP. Never imports or evaluates repository source itself. */
import { tap } from 'node:test/reporters';
import path from 'node:path';
import { realpathSync } from 'node:fs';

export default async function* reporter(events) {
  const root = realpathSync(process.env.SINGULARITY_FLOW_NODE_TEST_ROOT ?? process.cwd());
  const stacks = new Map();
  const files = new Map();
  const occurrences = [];
  let incomplete = false;
  async function* observe() {
    for await (const event of events) {
      const data = event.data ?? {};
      if (event.type === 'test:start' && data.file) {
        const stack = stacks.get(data.file) ?? [];
        stack.length = data.nesting;
        stack.push(data.name);
        stacks.set(data.file, stack);
      }
      if (['test:pass', 'test:fail'].includes(event.type) && data.details?.type !== 'suite') {
        // Windows temp/cwd paths can use an 8.3 alias while the root is canonical. Resolve
        // both sides before containment/identity checks; outside or missing files still fail.
        // One resolution per reported file avoids another filesystem read per test case.
        if (data.file && !files.has(data.file)) {
          try { files.set(data.file, path.relative(root, realpathSync(data.file)).replaceAll('\\', '/')); }
          catch { files.set(data.file, ''); }
        }
        const file = files.get(data.file) ?? '';
        const ancestors = (stacks.get(data.file) ?? []).slice(0, data.nesting);
        if (!file || file === '..' || file.startsWith('../') || path.isAbsolute(file)
            || !Number.isInteger(data.line) || data.line < 1 || typeof data.name !== 'string'
            || ancestors.length !== data.nesting || ancestors.some((name) => typeof name !== 'string')
            || occurrences.length >= 100_000) incomplete = true;
        else occurrences.push({ file, line: data.line, name: data.name, ancestorTitles: ancestors,
          outcome: data.skip || data.todo ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed',
          durationMs: data.details?.duration_ms ?? null });
      }
      yield event;
    }
  }
  if (process.env.SINGULARITY_FLOW_NODE_TEST_TAP === '0') {
    for await (const _event of observe()) { /* The configured reporter emits TAP. */ }
  } else yield* tap(observe());
  yield `# sflow-node-observation-v1 ${JSON.stringify({ complete: !incomplete, occurrences })}\n`;
}
