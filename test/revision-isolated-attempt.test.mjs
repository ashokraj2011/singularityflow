import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import {
  executeIsolatedRevisionAttempt, freezeRevisionAttemptCandidate,
  registerRevisionDeclarativeEditDriver
} from '../src/revision/isolated-attempt.mjs';

const boundary = { config: {}, workflow: {} };

async function fixture(t, { symlinkTree = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-isolated-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 1;\n');
  git('add', 'src/app.js');
  git('commit', '-m', 'baseline');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 2;\n');
  if (symlinkTree) await symlink('../src/app.js', path.join(root, 'link.js'));
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'revision@example.com' },
    createdAt: '2026-09-17T00:00:00.000Z'
  });
  const parentCandidate = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  return { root, git, parentCandidate };
}

test('registered declarative attempt starts from retained tree, bounds effects, and leaves visible Git state untouched', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  const source = Buffer.from('export const value = 3;\n');
  const driver = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src/app.js', bytes: source },
    { operation: 'write', path: 'src/new.js', bytes: Buffer.from('export const added = true;\n') }
  ]);
  source.fill(0); // registration pins exact bytes rather than retaining caller-owned memory
  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain');
  const result = await executeIsolatedRevisionAttempt({
    root, parentCandidate, driver, allowedPaths: ['src/app.js', 'src/new.js'], ...boundary
  });
  assert.equal(result.status, 'bounded-effects-collected');
  assert.equal(result.cleanup.verified, true);
  assert.equal(result.quiescence.processTreeQuiescent, true);
  assert.equal(result.quiescence.externalEffects, 'none-by-construction');
  assert.equal(result.promotionAllowed, false);
  assert.deepEqual(result.changes.map((change) => change.path), ['src/app.js', 'src/new.js']);
  assert.equal(result.changes[0].before.bytes, 'export const value = 2;\n'.length);
  assert.equal(result.changes[0].after.bytes, 'export const value = 3;\n'.length);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), status);
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');
});

test('arbitrary callbacks, shell drivers, scope escape, and forged parent refuse before effects', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  let invoked = false;
  const fake = {
    start() { invoked = true; }, observe() {}, requestStop() {}, quiesce() {}, collect() {}
  };
  await assert.rejects(executeIsolatedRevisionAttempt({
    root, parentCandidate, driver: fake, allowedPaths: ['src/app.js'], ...boundary
  }), { code: 'REV_ATTEMPT_DRIVER_UNSUPPORTED' });
  assert.equal(invoked, false);
  const driver = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src/app.js', bytes: Buffer.from('changed') }
  ]);
  await assert.rejects(executeIsolatedRevisionAttempt({
    root, parentCandidate, driver, allowedPaths: ['src/other.js'], ...boundary
  }), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
  await assert.rejects(executeIsolatedRevisionAttempt({
    root, parentCandidate: { ...parentCandidate, candidateSha256: `sha256:${'0'.repeat(64)}` },
    driver, allowedPaths: ['src/app.js'], ...boundary
  }), { code: 'REV_PARENT_CANDIDATE_UNVERIFIED' });
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');
});

test('unsafe paths and raw Git metadata targets cannot be registered', () => {
  for (const unsafe of ['../outside', '/tmp/outside', '.git/config', 'src/.GIT/config',
    'src\\outside', 'src/../outside', 'src//outside']) {
    assert.throws(() => registerRevisionDeclarativeEditDriver([
      { operation: 'write', path: unsafe, bytes: Buffer.from('bad') }
    ]), { code: 'REV_ATTEMPT_PATH_INVALID' });
  }
  assert.throws(() => registerRevisionDeclarativeEditDriver([{ operation: 'run', path: 'src/app.js' }]), {
    code: 'REV_ATTEMPT_DRIVER_INVALID'
  });
  assert.throws(() => registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'singularity/workflow.yml', bytes: Buffer.from('bad') }
  ]), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
});

test('configured governed roots refuse a caller-supplied allowed path', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  const driver = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src/app.js', bytes: Buffer.from('changed') }
  ]);
  await assert.rejects(executeIsolatedRevisionAttempt({
    root, parentCandidate, driver, allowedPaths: ['src/app.js'],
    config: { governedRoots: ['src'] }, workflow: {}
  }), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
});

test('explicit freeze creates exact immutable child tree without touching visible worktree or index', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  const driver = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src/app.js', bytes: Buffer.from('export const value = 3;\n') },
    { operation: 'write', path: 'src/new.js', bytes: Buffer.from('export const added = true;\n') }
  ]);
  const attemptResult = await executeIsolatedRevisionAttempt({
    root, parentCandidate, driver, allowedPaths: ['src/app.js', 'src/new.js'], ...boundary
  });
  assert.equal(attemptResult.status, 'bounded-effects-collected');
  const beforeStatus = git('status', '--porcelain');
  const beforeIndex = await readFile(path.join(root, '.git', 'index'));
  const beforeHead = git('rev-parse', 'HEAD');
  const proof = await freezeRevisionAttemptCandidate({
    root, parentCandidate, attemptResult, ...boundary,
    verifyAdmission: async (result) => result.evidenceSha256 === attemptResult.evidenceSha256,
    createdBy: { kind: 'agent', id: 'revision-agent' },
    createdAt: '2026-09-18T00:00:00.000Z'
  });
  assert.equal(proof.loopHeadAdvanced, false);
  assert.equal(proof.testingVerificationComplete, false);
  assert.equal(proof.parentCandidateId, parentCandidate.candidateId);
  assert.equal(proof.attemptEvidenceSha256, attemptResult.evidenceSha256);
  assert.equal(git('rev-parse', `${proof.childCommit}^{tree}`), proof.childTree);
  assert.equal(git('rev-parse', proof.childCandidate.namespace), proof.childCommit);
  assert.equal(git('show', `${proof.childCommit}:src/app.js`), 'export const value = 3;');
  assert.equal(git('show', `${proof.childCommit}:src/new.js`), 'export const added = true;');
  assert.deepEqual(git('diff-tree', '-r', '--name-only', parentCandidate.repository.candidateTree,
    proof.childTree).split('\n'), ['src/app.js', 'src/new.js']);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), beforeIndex);
  assert.equal(git('status', '--porcelain'), beforeStatus);
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');
  await assert.rejects(readFile(path.join(root, 'src', 'new.js')), { code: 'ENOENT' });
});

test('freeze refuses forged result, missing admission, and newly forbidden path before object writes', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  const driver = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src/app.js', bytes: Buffer.from('changed') }
  ]);
  const attemptResult = await executeIsolatedRevisionAttempt({
    root, parentCandidate, driver, allowedPaths: ['src/app.js'], ...boundary
  });
  const input = {
    root, parentCandidate, attemptResult, ...boundary,
    verifyAdmission: async () => true, createdBy: { kind: 'agent', id: 'revision-agent' }
  };
  await assert.rejects(freezeRevisionAttemptCandidate({
    ...input, attemptResult: { ...attemptResult }
  }), { code: 'REV_ATTEMPT_RESULT_UNVERIFIED' });
  await assert.rejects(freezeRevisionAttemptCandidate({
    ...input, verifyAdmission: undefined
  }), { code: 'REV_ATTEMPT_ADMISSION_REQUIRED' });
  await assert.rejects(freezeRevisionAttemptCandidate({
    ...input, config: { governedRoots: ['src'] }
  }), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');
});

test('symlink-bearing tree is not materialized and a failed started attempt becomes recovery-required', async (t) => {
  const unsafe = await fixture(t, { symlinkTree: true });
  const driver = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src/app.js', bytes: Buffer.from('changed') }
  ]);
  const refused = await executeIsolatedRevisionAttempt({
    root: unsafe.root, parentCandidate: unsafe.parentCandidate, driver,
    allowedPaths: ['src/app.js'], ...boundary
  });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.code, 'REV_ATTEMPT_TREE_UNSUPPORTED');
  assert.equal(refused.cleanup.verified, true);

  const safe = await fixture(t);
  const colliding = registerRevisionDeclarativeEditDriver([
    { operation: 'write', path: 'src', bytes: Buffer.from('cannot replace directory') }
  ]);
  const failed = await executeIsolatedRevisionAttempt({
    root: safe.root, parentCandidate: safe.parentCandidate, driver: colliding,
    allowedPaths: ['src'], ...boundary
  });
  assert.equal(failed.status, 'recovery-required');
  assert.equal(failed.cleanup.verified, true);
  assert.equal(failed.promotionAllowed, false);
  assert.equal(await readFile(path.join(safe.root, 'src', 'app.js'), 'utf8'), 'export const value = 2;\n');
});
