import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpTopicId, loadHelpDocument, parseHelpDocument } from '../src/help.mjs';
import { COMMAND_REGISTRY } from '../src/command-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('canonical help document exposes stable comprehensive topics', async () => {
  const content = await readFile(path.join(root, 'HELP.md'), 'utf8');
  const document = parseHelpDocument(content);
  assert.equal(document.title, 'Singularity Flow Help');
  assert.ok(document.topics.length >= 20);
  for (const topic of ['quick-start', 'workspaces-and-capabilities', 'story-intake', 'jira-intake', 'governed-agents-and-approval-authority', 'sequence-enforcement', 'workflow-performance-reports', 'git-state-transfer-and-recovery', 'vs-code-extension', 'copilot-commands', 'cli-to-copilot-skill-mapping', 'troubleshooting', 'cli-command-reference']) {
    assert.ok(document.topics.some((item) => item.id === topic), `missing ${topic}`);
  }
  assert.equal(new Set(document.topics.map((item) => item.id)).size, document.topics.length);
  assert.equal(helpTopicId('Git state transfer & recovery'), 'git-state-transfer-recovery');
});

test('the visible CLI reference names every registered top-level command', async () => {
  const reference = await loadHelpDocument('cli-command-reference');
  for (const command of COMMAND_REGISTRY) {
    assert.match(reference.content, new RegExp(`singularity-flow ${command.name}\\b`),
      `CLI Help Center reference is missing ${command.name}`);
  }
});

test('help loader returns the full manual or one focused topic', async () => {
  const complete = await loadHelpDocument();
  assert.match(complete.content, /## Quick start/);
  assert.match(complete.content, /## Troubleshooting/);
  const focused = await loadHelpDocument('jira-intake');
  assert.equal(focused.selectedTopic, 'jira-intake');
  assert.match(focused.content, /## Jira intake/);
  assert.doesNotMatch(focused.content, /## VS Code extension/);
  const sequencing = await loadHelpDocument('sequence-enforcement');
  assert.match(sequencing.content, /exits with code `2`/);
  assert.match(sequencing.content, /Out of sequence/);
  await assert.rejects(() => loadHelpDocument('does-not-exist'), /Available topics:/);
});

test('user documentation advertises current Copilot skill discovery and qualified invocation syntax', async () => {
  const documents = await Promise.all(
    ['README.md', 'HELP.md', 'HOW-TO.md'].map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])
  );
  for (const [file, content] of documents) {
    assert.doesNotMatch(content, /copilot skill list/, `${file} must use the current Copilot resource-list command`);
    assert.doesNotMatch(content, /\/singularity-flow:sflow-/, `${file} must not advertise the obsolete colon-qualified syntax`);
  }
  assert.match(documents.find(([file]) => file === 'README.md')[1], /\/singularity-flow\/sflow-/);
  assert.match(documents.find(([file]) => file === 'README.md')[1], /copilot plugins list --kind skill/);
});
