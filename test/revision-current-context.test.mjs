import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig, saveWorkflow } from '../src/state.mjs';
import {
  probeRevisionSavedState, readRevisionCurrentContext
} from '../src/revision/current-context.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await mkdir(path.join(root, 'singularity', 'work-items', 'STORY-1'), { recursive: true });
  await writeFile(path.join(root, 'app.txt'), 'original\n');
  await writeFile(path.join(root, 'singularity', 'work-items', 'STORY-1', 'workflow.json'), '{}\n');
  git('add', '.');
  git('commit', '-m', 'baseline');
  return { root, git, config: {}, workflow: { workItem: { id: 'STORY-1' } } };
}

test('saved-state probe is read-only and distinguishes Story-owned metadata from application edits', async (t) => {
  const value = await fixture(t);
  const beforeHead = value.git('rev-parse', 'HEAD');
  const beforeStatus = value.git('status', '--porcelain');
  const indexBefore = await readFile(path.join(value.root, '.git', 'index'));
  const clean = await probeRevisionSavedState(value.root, value);
  assert.equal(clean.headCommit, beforeHead);
  assert.equal(clean.savedTree, clean.headTree);
  assert.deepEqual(clean.changedPaths, []);
  assert.deepEqual(await readFile(path.join(value.root, '.git', 'index')), indexBefore);

  await writeFile(path.join(value.root, 'app.txt'), 'new application\n');
  await writeFile(path.join(value.root, 'singularity', 'work-items', 'STORY-1', 'workflow.json'), '{"currentPhase":"implementation"}\n');
  const dirty = await probeRevisionSavedState(value.root, value);
  assert.equal(dirty.savedTree, null);
  assert.deepEqual(dirty.applicationChangedPaths, ['app.txt']);
  assert.deepEqual(dirty.transactionOwnedPaths, ['singularity/work-items/STORY-1/workflow.json']);
  assert.deepEqual(dirty.otherGovernedPaths, []);
  assert.notEqual(dirty.editorDiskIndexBaselineSha256, clean.editorDiskIndexBaselineSha256);
  assert.equal(value.git('rev-parse', 'HEAD'), beforeHead);
  assert.notEqual(value.git('status', '--porcelain'), beforeStatus);
});

test('saved-state probe binds changed bytes, stage state, and untracked paths', async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.root, 'app.txt'), 'first\n');
  const first = await probeRevisionSavedState(value.root, value);
  await writeFile(path.join(value.root, 'app.txt'), 'second\n');
  const second = await probeRevisionSavedState(value.root, value);
  assert.notEqual(first.editorDiskIndexBaselineSha256, second.editorDiskIndexBaselineSha256);
  value.git('add', 'app.txt');
  const staged = await probeRevisionSavedState(value.root, value);
  assert.notEqual(second.editorDiskIndexBaselineSha256, staged.editorDiskIndexBaselineSha256);
  await writeFile(path.join(value.root, 'new.txt'), 'untracked\n');
  const untracked = await probeRevisionSavedState(value.root, value);
  assert.deepEqual(untracked.applicationChangedPaths, ['app.txt', 'new.txt']);
  assert.notEqual(staged.editorDiskIndexBaselineSha256, untracked.editorDiskIndexBaselineSha256);
});

test('current context cannot claim an uninitialized Story exists', async (t) => {
  const value = await fixture(t);
  await assert.rejects(readRevisionCurrentContext({ root: value.root, workId: 'STORY-1' }),
    /Missing singularity\/workflow\.yml/);
});

test('current context refuses unsaved or unobservable editor state and unverified bindings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-story-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'app.txt'), 'baseline\n');
  await initializeDefinition(root);
  git('add', '.');
  git('commit', '-m', 'setup');
  git('switch', '-c', 'STORY-1');
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const actor = { name: 'Revision Test', email: 'revision@example.com', login: null };
  await setAgentSession(root, config, actor, 'product-owner', 'STORY-1', {
    phaseId: 'intake', source: 'test'
  });
  const workflow = await createWorkflow(root, config, {
    id: 'STORY-1', title: 'Read-only REV context',
    source: { type: 'manual', key: 'STORY-1', title: 'Read-only REV context',
      description: 'Build an exact revision context.', acceptanceCriteria: ['Bind current state.'] },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    resolved: resolveWorkType(config, 'feature')
  });
  workflow.currentPhase = 'implementation';
  workflow.phases.implementation.status = 'in_progress';
  workflow.phases.implementation.generation = 1;
  await saveWorkflow(root, config, workflow);

  const common = { root, workId: 'STORY-1' };
  const cli = await readRevisionCurrentContext(common);
  assert.equal(cli.status, 'unavailable');
  assert.equal(cli.code, 'REV_EDITOR_STATE_UNAVAILABLE');
  assert.equal(cli.savedState.transactionOwnedPaths.includes('singularity/work-items/STORY-1/workflow.json'), true);
  const unsaved = await readRevisionCurrentContext({ ...common,
    observeEditorBuffers: async ({ repositoryRoot }) => ({ source: 'editor-host', repositoryRoot, status: 'unsaved',
      observationSha256: `sha256:${'1'.repeat(64)}` }) });
  assert.equal(unsaved.code, 'REV_EDITOR_UNSAVED');
  const saved = async ({ repositoryRoot }) => ({ source: 'editor-host', repositoryRoot, status: 'saved', dirtyDocumentCount: 0,
    observationSha256: `sha256:${'2'.repeat(64)}` });
  const missingBinding = await readRevisionCurrentContext({ ...common, observeEditorBuffers: saved });
  assert.equal(missingBinding.code, 'REV_BINDING_UNAVAILABLE');
  const ready = await readRevisionCurrentContext({ ...common, observeEditorBuffers: saved,
    readApprovedBindings: async () => ({ status: 'verified',
      approvedIntentSha256: `sha256:${'3'.repeat(64)}`,
      routeContractSha256: `sha256:${'4'.repeat(64)}`,
      proofProfileSha256: `sha256:${'5'.repeat(64)}`
    }) });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.subject.phaseId, 'implementation');
  assert.equal(ready.context.headCommit, git('rev-parse', 'HEAD'));
  assert.match(ready.context.editorDiskIndexBaselineSha256, /^sha256:[a-f0-9]{64}$/);
  let observed = 0;
  const changedEditor = await readRevisionCurrentContext({ ...common,
    observeEditorBuffers: async ({ repositoryRoot }) => ({ source: 'editor-host', repositoryRoot, status: 'saved',
      dirtyDocumentCount: 0, observationSha256: `sha256:${String(++observed).repeat(64)}` }),
    readApprovedBindings: async () => ({ status: 'verified',
      approvedIntentSha256: `sha256:${'3'.repeat(64)}`,
      routeContractSha256: `sha256:${'4'.repeat(64)}`,
      proofProfileSha256: `sha256:${'5'.repeat(64)}`
    }) });
  assert.equal(changedEditor.code, 'REV_EDITOR_STATE_CHANGED');
});
