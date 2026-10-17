import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { readStoryPathHistory } from '../src/story-path-history.mjs';
import { parseImmutableJson } from '../src/immutable-json-read.mjs';
import { withCommandReadScope } from '../src/read-scope.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { createDocumentReadSession } from '../src/documents-read.mjs';
import { parseAgentDependencies } from '../src/agent-document-parser.mjs';
import { parseAgentDependencies as publicParser } from '../src/agents.mjs';
import { loadWorkflow as publicWorkflowRead, workflowPath as publicWorkflowPath } from '../src/state.mjs';
import { loadWorkflow } from '../src/story-workflow-read.mjs';
import { workflowPath } from '../src/story-paths.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-policy-read-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Read Test');
  git('config', 'user.email', 'read@example.invalid');
  return { root, git };
}

test('pure agent parsing is the existing public parser, including its strict refusals', () => {
  assert.equal(parseAgentDependencies, publicParser);
  assert.throws(() => parseAgentDependencies('---\nname: x\n---\n# Body'), /description/);
});

test('the lifecycle facade retains the same canonical strict read and path implementations', () => {
  assert.equal(publicWorkflowRead, loadWorkflow);
  assert.equal(publicWorkflowPath, workflowPath);
});

test('immutable JSON cache shares no mutable objects and keys exact UTF-8 bytes', () => {
  const bytes = Buffer.from('{"nested":{"items":[1]}}');
  const first = parseImmutableJson(bytes); first.nested.items.push(2);
  assert.deepEqual(parseImmutableJson(bytes), { nested: { items: [1] } });
  assert.deepEqual(parseImmutableJson(Buffer.from('{"nested":{"items":[3]}}')), { nested: { items: [3] } });
  assert.throws(() => parseImmutableJson(Buffer.from([0xff])));
  assert.throws(() => parseImmutableJson(Buffer.from('{')));
});

test('batched history preserves full-history add/touch evidence, including merges and restores', async t => {
  const { root, git } = await repository(t);
  const relative = 'audit with spaces.json';
  const compare = () => {
    const old = flags => git('log', '--full-history', '--format=%H', ...flags, '--', relative).split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(readStoryPathHistory(root, relative, 'Audit'), {
      history: old(['--diff-filter=A']), touches: old([])
    });
  };
  await writeFile(path.join(root, relative), 'original'); git('add', '.'); git('commit', '-qm', 'add');
  compare();
  git('switch', '-qc', 'side');
  await writeFile(path.join(root, relative), 'changed'); git('add', '.'); git('commit', '-qm', 'change');
  git('switch', '-q', 'main');
  await writeFile(path.join(root, 'unrelated'), 'other'); git('add', '.'); git('commit', '-qm', 'other');
  git('merge', '--no-ff', '-qm', 'merge', 'side'); compare();
  git('rm', '-q', '--', relative); git('commit', '-qm', 'delete'); compare();
  await writeFile(path.join(root, relative), 'original'); git('add', '.'); git('commit', '-qm', 'restore'); compare();
  assert.deepEqual(readStoryPathHistory(root, 'absent.json', 'Missing'), { history: [], touches: [] });
});

test('history batching retains rename semantics and refuses failed or malformed reads', async t => {
  const { root, git } = await repository(t);
  await writeFile(path.join(root, 'old.json'), 'original bytes'); git('add', '.'); git('commit', '-qm', 'add');
  git('mv', 'old.json', 'new.json'); git('commit', '-qm', 'rename');
  for (const relative of ['old.json', 'new.json']) {
    const old = flags => git('log', '--full-history', '--format=%H', ...flags, '--', relative).split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(readStoryPathHistory(root, relative, 'Rename'), { history: old(['--diff-filter=A']), touches: old([]) });
  }
  for (const output of [{ status: 1, stdout: '' }, { status: 0, stdout: 'untrusted' }]) {
    assert.throws(() => readStoryPathHistory(root, 'x', 'Audit', { runCommand: () => output }), { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
  }
});

test('a document read session builds one catalog and refuses bytes changed afterward', async t => {
  const { root } = await repository(t), config = { workItemRoot: 'singularity/work-items' };
  const item = path.join(root, config.workItemRoot, 'READ-1');
  await mkdir(path.join(item, 'artifacts/intake'), { recursive: true });
  const target = path.join(item, 'artifacts/intake/intake.md');
  await writeFile(target, '# First\n');
  const workflow = { workItem: { id: 'READ-1' }, phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', label: 'Intake', status: 'in_progress', generation: 0,
      requiredArtifact: { path: 'artifacts/intake/intake.md' }, artifacts: [] } } };
  let builds = 0;
  await withCommandTiming({ increment(name) { if (name === 'documents.catalog-build') builds++; } }, async () => {
    const session = await createDocumentReadSession(root, config, workflow);
    session.records.find(row => row.id === 'PHASE-INTAKE').sha256 = 'forged';
    assert.match((await session.view('PHASE-INTAKE')).content, /First/);
    assert.match((await session.view('PHASE-INTAKE')).content, /First/);
    assert.equal(builds, 1);
    workflow.phases.intake.generation = 1;
    await assert.rejects(session.view('PHASE-INTAKE'), { code: 'DOCUMENT_REVIEW_CHANGED' });
    workflow.phases.intake.generation = 0;
    await writeFile(path.join(item, 'documents.json'), '{"documents":[]}');
    await assert.rejects(session.view('PHASE-INTAKE'), { code: 'DOCUMENT_REVIEW_CHANGED' });
    await rm(path.join(item, 'documents.json'));
    await writeFile(target, '# Changed\n');
    await assert.rejects(session.view('PHASE-INTAKE'), { code: 'DOCUMENT_HASH_MISMATCH' });
  });
});

test('closed history reuse ends at the read boundary', async t => {
  const { root, git } = await repository(t);
  await writeFile(path.join(root, 'audit.json'), 'one'); git('add', '.'); git('commit', '-qm', 'one');
  await withCommandReadScope(async () => {
    const first = readStoryPathHistory(root, 'audit.json', 'Audit');
    first.touches.length = 0;
    assert.equal(readStoryPathHistory(root, 'audit.json', 'Audit').touches.length, 1);
  });
  await writeFile(path.join(root, 'audit.json'), 'two'); git('add', '.'); git('commit', '-qm', 'two');
  await withCommandReadScope(() => assert.equal(readStoryPathHistory(root, 'audit.json', 'Audit').touches.length, 2));
});
