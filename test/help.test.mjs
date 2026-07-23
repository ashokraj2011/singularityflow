import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpTopicId, loadHelpDocument, parseHelpDocument } from '../src/help.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('canonical help document exposes stable comprehensive topics', async () => {
  const content = await readFile(path.join(root, 'HELP.md'), 'utf8');
  const document = parseHelpDocument(content);
  assert.equal(document.title, 'Singularity Flow Help');
  assert.ok(document.topics.length >= 20);
  for (const topic of ['quick-start', 'jira-intake', 'personas-and-approvals', 'sequence-enforcement', 'workflow-performance-reports', 'git-state-transfer-and-recovery', 'electron-desktop', 'copilot-commands', 'troubleshooting', 'cli-command-reference']) {
    assert.ok(document.topics.some((item) => item.id === topic), `missing ${topic}`);
  }
  assert.equal(new Set(document.topics.map((item) => item.id)).size, document.topics.length);
  assert.equal(helpTopicId('Git state transfer & recovery'), 'git-state-transfer-recovery');
});

test('help loader returns the full manual or one focused topic', async () => {
  const complete = await loadHelpDocument();
  assert.match(complete.content, /## Quick start/);
  assert.match(complete.content, /## Troubleshooting/);
  const focused = await loadHelpDocument('jira-intake');
  assert.equal(focused.selectedTopic, 'jira-intake');
  assert.match(focused.content, /## Jira intake/);
  assert.doesNotMatch(focused.content, /## Electron desktop/);
  const sequencing = await loadHelpDocument('sequence-enforcement');
  assert.match(sequencing.content, /exits with code `2`/);
  assert.match(sequencing.content, /Out of sequence/);
  await assert.rejects(() => loadHelpDocument('does-not-exist'), /Available topics:/);
});

test('desktop imports the canonical help manual and exposes searchable help navigation', async () => {
  const app = await readFile(path.join(root, 'apps/desktop/src/App.jsx'), 'utf8');
  const desktopPackage = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  assert.match(app, /import helpMarkdown from '\.\.\/\.\.\/\.\.\/HELP\.md\?raw'/);
  assert.match(app, /\['help', 'Help & guides'/);
  assert.match(app, /placeholder="Search help…"/);
  assert.match(app, /page === 'help'/);
  assert.match(app, />Open help</);
  assert.ok(desktopPackage.build.extraResources.some((item) => item.from === '../../HELP.md' && item.to === 'cli/HELP.md'));
});
