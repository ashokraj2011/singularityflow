import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { lifecycleEvent, recordPublicationProjection } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import {
  beginStoryStartJournal, readStoryStartJournal, recoverStoryStart,
  serializeConfigurationRestorePoint, updateStoryStartJournal
} from '../src/story-start-journal.mjs';
import { captureConfigurationState } from '../src/configuration-branch.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Start Recovery'], root);
  git(['config', 'user.email', 'start@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# start recovery\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'initial'], root);
  return root;
}

async function missing(target) {
  try { await access(target); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

test('Story-start recovery restores the original checkout and removes only its untouched branch', async () => {
  const root = await repository('sflow-story-start-');
  const base = git(['rev-parse', 'HEAD'], root);
  const journal = await beginStoryStartJournal(root, {
    id: 'START-1', targetBranch: 'START-1', targetBranchExisted: false,
    originalBranch: 'main', originalHead: base, baseCommit: base
  });
  git(['switch', '-c', 'START-1'], root);

  const recovered = await recoverStoryStart(root, 'START-1', { force: true });
  assert.equal(recovered.status, 'recovered');
  assert.equal(git(['branch', '--show-current'], root), 'main');
  assert.equal(git(['branch', '--list', 'START-1'], root), '');
  assert.equal(await readStoryStartJournal(root, 'START-1'), null);
  assert.ok(journal.transactionId);
});

test('Story-start recovery refuses an unrecognized commit and retains its journal', async () => {
  const root = await repository('sflow-story-start-diverged-');
  const base = git(['rev-parse', 'HEAD'], root);
  await beginStoryStartJournal(root, {
    id: 'START-2', targetBranch: 'START-2', targetBranchExisted: false,
    originalBranch: 'main', originalHead: base, baseCommit: base
  });
  git(['switch', '-c', 'START-2'], root);
  await writeFile(path.join(root, 'manual.txt'), 'manual commit\n');
  git(['add', 'manual.txt'], root);
  git(['commit', '-m', 'manual'], root);

  await assert.rejects(
    () => recoverStoryStart(root, 'START-2', { force: true }),
    (error) => error.code === 'STORY_START_RECOVERY_DIVERGED'
  );
  assert.equal(git(['branch', '--show-current'], root), 'START-2');
  assert.ok(await readStoryStartJournal(root, 'START-2'));
});

test('recovery never restores Story configuration bytes onto an already stable original branch', async () => {
  const root = await repository('sflow-story-start-original-stable-');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: before-start\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'configuration baseline'], root);
  const base = git(['rev-parse', 'HEAD'], root);
  const captured = await captureConfigurationState(root);
  const journal = await beginStoryStartJournal(root, {
    id: 'START-STABLE', targetBranch: 'START-STABLE', targetBranchExisted: false,
    originalBranch: 'main', originalHead: base, baseCommit: base
  });
  await updateStoryStartJournal(root, 'START-STABLE', journal.transactionId, {
    stage: 'configuration-captured',
    configurationRestorePoint: serializeConfigurationRestorePoint(captured)
  });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: operator-owned-original\n');

  const recovered = await recoverStoryStart(root, 'START-STABLE', { force: true });
  assert.equal(recovered.status, 'recovered');
  assert.equal(git(['branch', '--show-current'], root), 'main');
  assert.equal(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'),
    'version: operator-owned-original\n');
});

test('Story start refuses a pre-existing local branch with no governed state or seed', async () => {
  const root = await repository('sflow-story-start-ungoverned-branch-');
  const initialized = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  git(['add', '.'], root);
  git(['commit', '-m', 'initialize governance'], root);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-start-remote-'));
  git(['init', '--bare'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  git(['branch', 'START-UNGOVERNED'], root);

  const started = spawnSync(process.execPath, [cli, 'start', 'START-UNGOVERNED', '--json', '--yes'], {
    cwd: root, encoding: 'utf8'
  });
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /neither governed Story state nor a materialized Story seed/);
  assert.equal(git(['branch', '--show-current'], root), 'main');
});

test('an exact governed binding commit completes start recovery instead of being rolled back', async () => {
  const root = await repository('sflow-story-start-complete-');
  const base = git(['rev-parse', 'HEAD'], root);
  const subject = { kind: 'story', id: 'START-3', branch: 'START-3' };
  const journal = await beginStoryStartJournal(root, {
    id: subject.id, targetBranch: subject.branch, targetBranchExisted: false,
    originalBranch: 'main', originalHead: base, baseCommit: base
  });
  journal.workItemRelative = 'singularity/work-items/START-3';
  await updateStoryStartJournal(root, subject.id, journal.transactionId, {
    workItemRelative: journal.workItemRelative
  });
  git(['switch', '-c', subject.branch], root);
  const target = `${journal.workItemRelative}/workflow.json`;
  const event = lifecycleEvent({ type: 'binding', subject });
  await new GitPublicationUnitOfWork(root).execute({
    subject,
    transactionId: journal.transactionId,
    event,
    commit: { message: '[START-3][init] governed start' },
    publication: { mode: 'off', branch: subject.branch },
    allowedPaths: [journal.workItemRelative],
    state: {
      write: async (publicationEvent) => {
        const workflow = { workItem: { id: subject.id, branch: subject.branch }, publicationProjections: [] };
        recordPublicationProjection(workflow, publicationEvent);
        await mkdir(path.dirname(path.join(root, target)), { recursive: true });
        await writeFile(path.join(root, target), `${JSON.stringify(workflow, null, 2)}\n`);
      }
    }
  });

  const recovered = await recoverStoryStart(root, subject.id, { force: true });
  assert.equal(recovered.status, 'completed');
  assert.equal(git(['branch', '--show-current'], root), subject.branch);
  assert.equal(await missing(path.join(root, target)), false);
  assert.equal(await readStoryStartJournal(root, subject.id), null);
});

test('a dead Story start restores configuration, sessions, and sibling checkouts together', async () => {
  const root = await repository('sflow-story-start-planes-');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: original\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'configuration baseline'], root);
  const base = git(['rev-parse', 'HEAD'], root);

  const sibling = await repository('sflow-story-start-sibling-');
  const siblingBase = git(['rev-parse', 'HEAD'], sibling);
  const id = 'START-PLANES';
  const captured = await captureConfigurationState(root);
  const journal = await beginStoryStartJournal(root, {
    id,
    targetBranch: id,
    targetBranchExisted: false,
    originalBranch: 'main',
    originalHead: base,
    baseCommit: base,
    originalSession: null,
    originalCopilotSession: null,
    siblingRepositories: [{
      repository: 'sibling', target: sibling, from: 'main',
      targetBranchExisted: false, baseCommit: siblingBase
    }]
  });
  await updateStoryStartJournal(root, id, journal.transactionId, {
    stage: 'configuration-captured',
    configurationRestorePoint: serializeConfigurationRestorePoint(captured)
  });

  git(['switch', '-c', id], root);
  git(['switch', '-c', id], sibling);
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: partial-materialization\n');
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/partial.md'), 'partial agent\n');
  const localState = path.join(root, '.git/singularity-flow');
  await mkdir(localState, { recursive: true });
  await writeFile(path.join(localState, 'session.json'), '{"partial":true}\n');
  await writeFile(path.join(localState, 'copilot-session.json'), '{"partial":true}\n');

  const recovered = await recoverStoryStart(root, id, { force: true });
  assert.equal(recovered.status, 'recovered');
  assert.equal(git(['branch', '--show-current'], root), 'main');
  assert.equal(git(['branch', '--show-current'], sibling), 'main');
  assert.equal(git(['branch', '--list', id], root), '');
  assert.equal(git(['branch', '--list', id], sibling), '');
  assert.equal(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), 'version: original\n');
  assert.equal(await missing(path.join(root, '.github/agents/partial.md')), true);
  assert.equal(await missing(path.join(localState, 'session.json')), true);
  assert.equal(await missing(path.join(localState, 'copilot-session.json')), true);
});
