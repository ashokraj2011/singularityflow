import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evidenceConsistencyHtml } from '../apps/vscode/src/views/webview.ts';

test('VS Code renders the CLI summary verbatim and escaped; it does not recompute verdicts or preselect a decision', () => {
  const lines = ['implementation: 33 passed; source binding matched.',
    'verification: no test execution retained; UPI-001 needs a human decision.',
    'WIT-001: recorded human acceptance.', '<script>unsafe()</script>'];
  const html = evidenceConsistencyHtml({ projectionSha256: 'sha256:abc', summary: lines });
  for (const line of lines.slice(0, 3)) assert.ok(html.includes(`<li>${line}</li>`));
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>|<input|<button|\bchecked\b/u);
  assert.match(html, /sha256:abc/u);
  assert.equal(evidenceConsistencyHtml(null), '');
});

test('approval UI receives the same CLI evidence snapshot, without changing the confirmation ceremony', async () => {
  const actions = await readFile(new URL('../apps/vscode/src/actions.ts', import.meta.url), 'utf8');
  const approval = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  assert.match(actions, /evidenceConsistency: storyReview\?\.evidenceConsistency \?\? null/u);
  assert.match(approval, /evidenceConsistencyHtml\(request.evidenceConsistency\)/u);
  assert.match(actions, /if \(!\(await stillCurrent\(\)\)\) return false/u);
});
