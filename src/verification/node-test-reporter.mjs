/** Native node:test events alongside TAP. Never imports or evaluates repository source itself. */
import { tap } from 'node:test/reporters';
import path from 'node:path';
import { realpathSync } from 'node:fs';

export default async function* reporter(events) {
  // The JS symlink walker preserves Windows 8.3 components; the native filesystem
  // canonicalizer also expands those aliases so root and event paths share one namespace.
  const root = realpathSync.native(process.env.SINGULARITY_FLOW_NODE_TEST_ROOT ?? process.cwd());
  const stacks = new Map();
  const files = new Map();
  const occurrences = [];
  // Each failed case's error message, aligned with occurrences, on a line of its own: the occurrences
  // (and so every attempt that keeps them) are exactly what they were; only the test summary reads it.
  const messages = [];
  const incomplete = new Set();
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
          try { files.set(data.file, path.relative(root, realpathSync.native(data.file)).replaceAll('\\', '/')); }
          catch { files.set(data.file, ''); }
        }
        const file = files.get(data.file) ?? '';
        const ancestors = (stacks.get(data.file) ?? []).slice(0, data.nesting);
        const issues = [];
        if (!file) issues.push(!data.file ? 'file-missing' : String(data.file).startsWith('file:') ? 'file-url-unresolved' : 'file-unresolved');
        else if (file === '..' || file.startsWith('../') || path.isAbsolute(file)) issues.push('file-outside-root');
        if (!Number.isInteger(data.line) || data.line < 1) issues.push('source-line-missing');
        if (typeof data.name !== 'string') issues.push('name-invalid');
        if (ancestors.length !== data.nesting || ancestors.some((name) => typeof name !== 'string')) issues.push('ancestry-mismatch');
        if (occurrences.length >= 100_000) issues.push('occurrence-limit');
        if (issues.length) for (const issue of issues) incomplete.add(issue);
        else {
          const outcome = data.skip || data.todo ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed';
          occurrences.push({ file, line: data.line, name: data.name, ancestorTitles: ancestors, outcome, durationMs: data.details?.duration_ms ?? null });
          const cause = data.details?.error?.cause ?? data.details?.error;
          messages.push(outcome === 'failed' && cause != null ? String(typeof cause?.message === 'string' ? cause.message : cause).slice(0, 2_000) : null);
        }
      }
      yield event;
    }
  }
  if (process.env.SINGULARITY_FLOW_NODE_TEST_TAP === '0') {
    for await (const _event of observe()) { /* The configured reporter emits TAP. */ }
  } else yield* tap(observe());
  if (messages.some((message) => message != null)) yield `# sflow-node-messages-v1 ${JSON.stringify({ messages })}\n`;
  yield `# sflow-node-observation-v1 ${JSON.stringify({ complete: incomplete.size === 0, occurrences,
    ...(incomplete.size ? { issues: [...incomplete] } : {}) })}\n`;
}
