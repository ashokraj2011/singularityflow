import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { helpTopicForError } from '../src/help-errors.mjs';

test('stable error identifiers resolve to reviewed help without carrying transcripts or paths', () => {
  assert.equal(helpTopicForError({ code: 'AST_WARM_TIMEOUT' }), 'ast-intelligence');
  assert.equal(helpTopicForError({ messageId: 'generation.intent.consumed-changed' }), 'artifacts-and-generation');
  assert.equal(helpTopicForError({ operation: 'workspace.refresh-configuration' }), 'workspaces-and-sessions');
  assert.equal(helpTopicForError({ message: 'Missing singularity/workflow.yml. Run init.' }), 'installation-and-upgrades');
  assert.equal(helpTopicForError({ message: 'unrelated application exception' }), null);
});

test('result cards route Explain this error through the closed webview contract', async () => {
  const [panel, page] = await Promise.all([
    readFile(new URL('../apps/vscode/src/views/result-panel.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/vscode/src/views/result-card-page.ts', import.meta.url), 'utf8')
  ]);
  assert.match(panel, /data-result-nav="help">Explain this error/);
  assert.match(panel, /'result\.help'/);
  assert.match(page, /destination === 'help' \? 'result\.help'/);
});
