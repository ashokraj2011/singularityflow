/**
 * Which phases accept Story documents, and what the governance gate accepts afterwards.
 *
 * spec-driven-standard shares no phase name with the global upload list, so its list resolved to
 * nothing and every document was refused — including those given at Story start from VS Code,
 * which has no terminal to confirm a soft gate. These run every command without a terminal, as
 * VS Code does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { loadDefinition } from '../src/config.mjs';
import { documentUploadPhases } from '../src/documents.mjs';
import { loadStoryAggregate } from '../src/state-stores.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Upload Phase Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' })
  };
  // No terminal: standard input is a pipe, exactly like the VS Code extension's CLI calls.
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options = {}) { return run(process.execPath, [bin, ...args], root, options); }

async function repository(configure = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-upload-phases-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Upload Phase Tester'], root);
  run('git', ['config', 'user.email', 'upload-phases@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Upload phases\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  configure(config);
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

async function brief(name, text) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-upload-phase-files-'));
  const file = path.join(directory, name);
  await writeFile(file, text);
  return file;
}

async function catalog(root, workId) {
  return JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'documents.json'), 'utf8'));
}

function documentGateErrors(root) {
  const gate = flow(root, ['gate'], { allowFailure: true });
  const output = `${gate.stdout}\n${gate.stderr}`;
  return output.split('\n').filter((line) => /uploaded outside|document count differs|documents\.json is missing|document name|offered to phases/.test(line));
}

test('a spec-driven Story takes documents at start and in its first phase without a terminal', async () => {
  const root = await repository();
  const start = await brief('payment brief.md', '# Payment brief\nRetry a failed payment once.\n');
  flow(root, ['start', 'SPEC-DOC-1', '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Retry a failed payment', '--description', 'Let an operator retry a failed payment.',
    '--document', start, '--document-name', 'Payment brief']);
  const opened = await catalog(root, 'SPEC-DOC-1');
  assert.equal(opened.documents.length, 1);
  assert.equal(opened.documents[0].phase, 'specification');
  assert.equal(opened.documents[0].name, 'Payment brief');
  assert.equal(opened.documents[0].origin, 'story-start', 'the opening record says where the document came from');

  const definition = await loadDefinition(root);
  const workflow = await loadStoryAggregate(root, definition, 'SPEC-DOC-1');
  assert.deepEqual(workflow.resolution.documents.allowedPhases, [], 'the pinned list is still empty');
  assert.deepEqual(documentUploadPhases(workflow, definition), ['specification'],
    'an empty list falls back to the first phase');

  const later = await brief('provider notes.md', '# Provider notes\nThe provider returns 409 on a duplicate.\n');
  flow(root, ['documents', 'upload', later, '--name', 'Provider notes']);
  const uploaded = await catalog(root, 'SPEC-DOC-1');
  assert.deepEqual(uploaded.documents.map((record) => record.id), ['DOC-001', 'DOC-002']);
  assert.equal(uploaded.documents[1].origin, undefined, 'only Story creation records an origin');
  assert.deepEqual(documentGateErrors(root), []);
});

test('a deliberately narrowed upload list is kept, but documents given at Story start are admitted', async () => {
  const root = await repository((config) => { config.documents.allowedPhases = ['requirements']; });
  const start = await brief('customer brief.md', '# Customer brief\nExport orders as CSV.\n');
  flow(root, ['start', 'NARROW-1', '--from-branch', 'main', '--title', 'Export orders', '--document', start, '--document-name', 'Customer brief']);
  const opened = await catalog(root, 'NARROW-1');
  assert.equal(opened.documents[0].phase, 'intake');
  assert.equal(opened.documents[0].origin, 'story-start');

  const later = await brief('late notes.md', '# Late notes\n');
  const refused = flow(root, ['documents', 'upload', later, '--name', 'Late notes'], { allowFailure: true });
  assert.notEqual(refused.status, 0, 'an upload during intake is still outside the configured list');
  assert.match(refused.stderr, /only during: requirements/);
  assert.equal((await catalog(root, 'NARROW-1')).documents.length, 1);
  assert.deepEqual(documentGateErrors(root), [], 'the Story-start document is part of the opening record');

  // A confirmed override is audited on the workflow; the gate accepts what it admitted.
  flow(root, ['documents', 'upload', later, '--name', 'Late notes', '--confirm-override', 'continue:documentPhase']);
  assert.equal((await catalog(root, 'NARROW-1')).documents.length, 2);
  assert.deepEqual(documentGateErrors(root), []);
});

test('the gate counts active and total documents after a detach, and still reads older counters', async () => {
  const root = await repository((config) => { config.documents.allowedPhases = ['intake']; });
  flow(root, ['start', 'COUNT-1', '--from-branch', 'main', '--title', 'Count documents']);
  flow(root, ['documents', 'upload', await brief('first.md', '# First\n'), '--name', 'First brief']);
  flow(root, ['documents', 'detach', 'DOC-001', '--reason', 'Superseded by a newer brief', '--yes']);
  assert.deepEqual(documentGateErrors(root), [], 'a detach alone no longer breaks the count');
  flow(root, ['documents', 'upload', await brief('second.md', '# Second\n'), '--name', 'Second brief']);
  assert.deepEqual(documentGateErrors(root), []);

  const workflowPath = path.join(root, 'singularity/work-items/COUNT-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.deepEqual([workflow.documents.count, workflow.documents.totalCount], [1, 2]);

  // An older Story wrote only `count`, as the total after an upload.
  workflow.documents = { count: 2, updatedAt: workflow.documents.updatedAt };
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  assert.deepEqual(documentGateErrors(root), []);
  workflow.documents = { count: 3, updatedAt: workflow.documents.updatedAt };
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  assert.equal(documentGateErrors(root).length, 1, 'a count that matches nothing is still an error');
});
