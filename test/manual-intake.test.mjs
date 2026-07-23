import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Manual Intake Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' })
  };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args) { return run(process.execPath, [bin, ...args], root); }

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-manual-intake-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Manual Intake Tester'], root);
  run('git', ['config', 'user.email', 'manual-intake@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Manual intake test\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('manual story intake commits complete details and every supplied document without Jira', async () => {
  const root = await repository();
  const intake = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-input-'));
  await writeFile(path.join(intake, 'brief.md'), '# Brief\nCustomer research and workflow evidence.\n');
  await writeFile(path.join(intake, 'extra.txt'), 'Additional stakeholder notes.\n');
  await writeFile(path.join(intake, 'story.yml'), YAML.stringify({
    title: 'Add invoice export',
    user: 'Finance analyst',
    problem: 'Invoice exports are assembled manually.',
    desiredOutcome: 'Export the filtered invoice set.',
    scope: { in: ['Filtered invoices'], out: ['Scheduled delivery'] },
    stakeholders: ['Finance', 'Billing engineering'],
    urgency: 'Before month end',
    constraints: ['Reuse existing authorization'],
    dependencies: ['Invoice search API'],
    acceptanceCriteria: ['Authorized users can export.', 'Unauthorized users are denied.'],
    risks: ['Large exports'],
    notes: 'Confirm CSV column order.',
    documents: [
      { path: './brief.md', label: 'Research brief', kind: 'requirements' },
      { url: 'https://www.figma.com/design/invoice-export', label: 'Invoice design', kind: 'figma' }
    ]
  }));

  flow(root, [
    'start', 'WORK-123', '--story-file', path.join(intake, 'story.yml'),
    '--document', path.join(intake, 'extra.txt'),
    '--document-url', 'https://example.com/context'
  ]);

  const workRoot = path.join(root, 'singularity/work-items/WORK-123');
  const source = JSON.parse(await readFile(path.join(workRoot, 'source.json'), 'utf8'));
  assert.equal(source.type, 'manual');
  assert.equal(source.title, 'Add invoice export');
  assert.equal(source.description, 'Invoice exports are assembled manually.');
  assert.match(source.acceptanceCriteria, /Authorized users can export/);
  assert.equal(source.documents, undefined);

  const story = await readFile(path.join(workRoot, 'USER-STORY.md'), 'utf8');
  assert.match(story, /## User or audience\n\nFinance analyst/);
  assert.match(story, /## Desired outcome\n\nExport the filtered invoice set/);
  assert.match(story, /## Constraints/);
  assert.match(story, /Unauthorized users are denied/);

  const catalog = JSON.parse(await readFile(path.join(workRoot, 'documents.json'), 'utf8'));
  assert.equal(catalog.documents.length, 4);
  assert.equal(catalog.documents[0].label, 'Research brief');
  assert.equal(catalog.documents[0].sha256.length, 64);
  assert.equal(catalog.documents[1].kind, 'figma');
  assert.equal(catalog.documents[1].url, 'https://www.figma.com/design/invoice-export');
  assert.equal(catalog.documents[2].sourceName, 'extra.txt');
  assert.equal(catalog.documents[3].url, 'https://example.com/context');

  const log = run('git', ['log', '--format=%s'], root).stdout;
  assert.match(log, /\[WORK-123\]\[init\] start feature workflow/);
  assert.equal((log.match(/\[WORK-123\]\[documents\]\[upload\]/g) ?? []).length, 4);

  const guide = flow(root, ['guide']).stdout;
  assert.match(guide, /WORK-123 — Feature \(feature\)/);
  assert.match(guide, /\/sflow-phase/);
  assert.match(guide, /artifacts\/intake\/intake\.md/);
});
