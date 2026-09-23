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

test('the checked-in SGOS command index matches the public action families and required trust input', async () => {
  const reference = (await loadHelpDocument('cli-command-reference')).content;
  assert.match(reference,
    /intent capture\|packet\|confirm\|workflow\|ratification-packet\|ratify\|show\|validate\|compile/);
  assert.match(reference,
    /program show\|validate\|explain\|simulate\|what-if\|fault-plan\|approve/);
  assert.match(reference,
    /process list\|status\|graph\|fsck\|step\|run\|pause\|stop\|resume\|recover\|replay\|fork/);
  assert.match(reference, /policy status\|fsck\|plan\|apply/);
  assert.match(reference, /task list\|show\|evidence\|retry/);
  const learningLines = reference.split('\n').filter((entry) =>
    entry.startsWith('singularity-flow learn '));
  for (const line of learningLines.filter((entry) =>
    !/^singularity-flow learn (?:bundle-inspect|workspace|progress\|progress-export|progress-import|reset)\b/.test(entry))) {
    assert.match(line, /--trust PUBLIC-TRUST\.json/, `learning command is missing trust input: ${line}`);
  }
  for (const action of ['bundle-inspect', 'workspace', 'progress|progress-export', 'progress-import', 'reset']) {
    const line = learningLines.find((entry) => entry.startsWith(`singularity-flow learn ${action} `));
    assert.ok(line, `learning command index is missing local ${action}`);
    assert.doesNotMatch(line, /--trust/, `${action} must remain available without Pack credentials`);
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
    assert.doesNotMatch(content, /copilot plugins list --kind/, `${file} must not advertise the retired scoped inventory command`);
    assert.doesNotMatch(content, /\/singularity-flow:sflow-/, `${file} must not advertise the obsolete colon-qualified syntax`);
  }
  assert.match(documents.find(([file]) => file === 'README.md')[1], /\/singularity-flow\/sflow-/);
  assert.match(documents.find(([file]) => file === 'README.md')[1], /copilot skill list --json/);
});

test('canonical help documents repository onboarding as an exact preview and confirmation', async () => {
  const content = await readFile(path.join(root, 'HELP.md'), 'utf8');
  assert.match(content, /capability onboard <REPOSITORY-URL> --dry-run --json/);
  assert.match(content, /capability onboard <REPOSITORY-URL> --confirm-plan <PLAN-ID> --json/);
  assert.match(content, /repository-onboarding-plan\/v1/);
  assert.match(content, /exact effects and preserved data/);
  assert.match(content, /never invents a recovery\s+mode/i);
  assert.match(content, /`--migrate`, `--recreate`, and `--reset-local` are explicit choices/i);
  assert.match(content, /inspect-repository` remains a one-release compatibility diagnostic/i);
});
