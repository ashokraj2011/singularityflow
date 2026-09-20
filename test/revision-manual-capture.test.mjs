import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import {
  freezeManualRevisionCandidate, planManualRevisionCapture
} from '../src/revision/manual-capture.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-manual-test-'));
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
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'revision@example.com' },
    createdAt: '2026-09-18T00:00:00.000Z'
  });
  const parentCandidate = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  return { root, git, parentCandidate };
}

const editorProof = async () => ({
  status: 'all-saved', snapshotSha256: `sha256:${'a'.repeat(64)}`
});
const subjectId = 'PAY-142:implementation';

test('manual capture refuses configured protected paths during planning', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  const refsBefore = git('show-ref');
  let editorProofCalls = 0;

  await assert.rejects(planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Attempt to capture a protected source file',
    allowedPaths: ['src/app.js'],
    config: { governance: { protectedPaths: ['src/'] } }, workflow: {},
    verifySavedEditorBuffers: async () => {
      editorProofCalls += 1;
      return editorProof();
    }
  }), (error) => {
    assert.equal(error.code, 'REV_MANUAL_PROTECTED_PATH');
    assert.match(error.message, /src\/app\.js/u);
    return true;
  });

  assert.equal(editorProofCalls, 0, 'protected paths must be refused before editor proof or freeze');
  assert.equal(git('show-ref'), refsBefore, 'planning must not create a revision Candidate');
});

test('manual capture refuses secret-bearing saved bytes before candidate freeze', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  const credential = `AKIA${'Q7RJ2NXWMBK4TZVD'}`;
  await writeFile(path.join(root, 'src', 'app.js'),
    `export const credential = "${credential}";\n`);
  const refsBefore = git('show-ref');
  let editorProofCalls = 0;

  await assert.rejects(planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Attempt to capture secret-bearing saved bytes',
    allowedPaths: ['src/app.js'], config: {}, workflow: {},
    verifySavedEditorBuffers: async () => {
      editorProofCalls += 1;
      return editorProof();
    }
  }), (error) => {
    assert.equal(error.code, 'REV_MANUAL_SECRET_DETECTED');
    assert.match(error.message, /AWS access key ID/u);
    assert.doesNotMatch(error.message, new RegExp(credential, 'u'));
    return true;
  });

  assert.equal(editorProofCalls, 0, 'secret scanning must finish before editor proof or freeze');
  assert.equal(git('show-ref'), refsBefore, 'secret refusal must not create a revision Candidate');
});

test('clean manual plan records safety passes and transparent editor-proof assurance', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  const snapshotSha256 = `sha256:${'c'.repeat(64)}`;
  const plan = await planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Capture clean saved source',
    allowedPaths: ['src/app.js'],
    config: { governance: { protectedPaths: ['config'] } },
    workflow: { resolution: { capability: { policy: { protectedPaths: ['infra/'] } } } },
    verifySavedEditorBuffers: async () => ({
      status: 'all-saved', snapshotSha256, assurance: 'user-asserted'
    })
  });

  assert.equal(plan.status, 'ready-for-explicit-freeze');
  assert.deepEqual(plan.findings, []);
  assert.deepEqual(plan.protectedPathCheck,
    { status: 'pass', checkedPathCount: 1, guardCount: 2 });
  assert.deepEqual(plan.secretScan, { status: 'pass', scanned: 1, skipped: 0, waived: 0 });
  assert.deepEqual(plan.editorBuffers,
    { status: 'all-saved', snapshotSha256, assurance: 'user-asserted' });
});

test('manual plan inventories index, saved worktree, untracked files, and candidate separately', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  git('add', 'src/app.js');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 4;\n');
  await writeFile(path.join(root, 'src', 'new.js'), 'export const added = true;\n');
  const beforeHead = git('rev-parse', 'HEAD');
  const beforeStatus = git('status', '--porcelain');
  const beforeIndex = await readFile(path.join(root, '.git', 'index'));
  const plan = await planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Use saved value four and new code',
    allowedPaths: ['src/app.js', 'src/new.js'],
    stagedDisposition: 'capture-saved-disk', untrackedDisposition: 'capture-listed',
    config: {}, workflow: {}
  });
  assert.equal(plan.status, 'unavailable');
  assert.deepEqual(plan.findings.map((item) => item.code), ['REV_UNSAVED_BUFFERS']);
  assert.deepEqual(plan.drift.map((item) => item.path), ['src/app.js', 'src/new.js']);
  assert.equal(plan.drift[0].staged, true);
  assert.equal(plan.drift[0].unstaged, true);
  assert.equal(plan.drift[0].candidateDrift, true);
  assert.equal(plan.drift[0].index.oid === plan.drift[0].saved.oid, false);
  assert.equal(plan.drift[1].untracked, true);
  assert.equal(plan.loopHeadAdvanced, false);
  assert.equal(plan.storyPublished, false);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('status', '--porcelain'), beforeStatus);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), beforeIndex);
  await assert.rejects(freezeManualRevisionCandidate({
    root, subjectId, parentCandidate, plan, config: {}, workflow: {},
    verifyAdmission: async () => true,
    createdBy: { kind: 'human', id: 'revision@example.com' }
  }), { code: 'REV_MANUAL_PLAN_UNVERIFIED' });
});

test('explicit trusted editor proof and admission freeze saved bytes without advancing Story or head', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  await writeFile(path.join(root, 'src', 'new.js'), 'export const added = true;\n');
  const options = {
    root, subjectId, parentCandidate, note: 'Capture saved manual code',
    allowedPaths: ['src/app.js', 'src/new.js'],
    untrackedDisposition: 'capture-listed', config: {}, workflow: {},
    verifySavedEditorBuffers: editorProof
  };
  const plan = await planManualRevisionCapture(options);
  assert.equal(plan.status, 'ready-for-explicit-freeze');
  assert.deepEqual(plan.findings, []);
  const beforeHead = git('rev-parse', 'HEAD');
  const beforeStatus = git('status', '--porcelain');
  const beforeIndex = await readFile(path.join(root, '.git', 'index'));
  const result = await freezeManualRevisionCandidate({
    ...options, plan,
    verifyAdmission: async ({ plan: fresh, attemptResult }) =>
      fresh.planSha256 === plan.planSha256 && attemptResult.cleanup.verified === true,
    createdBy: { kind: 'human', id: 'revision@example.com' },
    createdAt: '2026-09-18T01:00:00.000Z'
  });
  assert.equal(result.loopHeadAdvanced, false);
  assert.equal(result.precheckRecorded, false);
  assert.equal(result.storyPublished, false);
  assert.equal(result.frozen.loopHeadAdvanced, false);
  assert.equal(git('rev-parse', `${result.frozen.childCommit}^{tree}`), result.frozen.childTree);
  assert.equal(git('show', `${result.frozen.childCommit}:src/app.js`), 'export const value = 3;');
  assert.equal(git('show', `${result.frozen.childCommit}:src/new.js`), 'export const added = true;');
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('status', '--porcelain'), beforeStatus);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), beforeIndex);
});

test('manual freeze refuses changed saved bytes and changed editor-buffer evidence', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  const options = {
    root, subjectId, parentCandidate, note: 'Capture saved update', allowedPaths: ['src/app.js'],
    config: {}, workflow: {}, verifySavedEditorBuffers: editorProof
  };
  const plan = await planManualRevisionCapture(options);
  assert.equal(plan.status, 'ready-for-explicit-freeze');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 4;\n');
  await assert.rejects(freezeManualRevisionCandidate({
    ...options, plan, verifyAdmission: async () => true,
    createdBy: { kind: 'human', id: 'revision@example.com' }
  }), { code: 'REV_MANUAL_PLAN_STALE' });
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  await assert.rejects(freezeManualRevisionCandidate({
    ...options, plan,
    verifySavedEditorBuffers: async () => ({
      status: 'all-saved', snapshotSha256: `sha256:${'b'.repeat(64)}`
    }),
    verifyAdmission: async () => true,
    createdBy: { kind: 'human', id: 'revision@example.com' }
  }), { code: 'REV_MANUAL_PLAN_STALE' });
});

test('manual capture refuses protected, missing-disposition, and unselected drift', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  await writeFile(path.join(root, 'src', 'new.js'), 'export const added = true;\n');
  const plan = await planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Capture app only', allowedPaths: ['src/app.js'],
    config: {}, workflow: {}, verifySavedEditorBuffers: editorProof
  });
  assert.equal(plan.status, 'unavailable');
  assert.deepEqual(plan.findings.map((item) => item.code), [
    'REV_MANUAL_PATH_SELECTION_REQUIRED', 'REV_MANUAL_UNTRACKED_DISPOSITION_REQUIRED'
  ]);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'protected');
  const protectedPlan = await planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Cannot capture governance',
    allowedPaths: ['src/app.js', 'src/new.js', 'singularity/workflow.yml'],
    untrackedDisposition: 'capture-listed', config: {}, workflow: {},
    verifySavedEditorBuffers: editorProof
  });
  assert.equal(protectedPlan.status, 'unavailable');
  assert.ok(protectedPlan.findings.some((item) => item.code === 'REV_MANUAL_SCOPE_REFUSED'));
});

test('manual inventory honors Git core.filemode=false instead of inventing Windows executable drift', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  git('config', 'core.filemode', 'false');
  await chmod(path.join(root, 'src', 'app.js'), 0o755);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  const plan = await planManualRevisionCapture({
    root, subjectId, parentCandidate, note: 'Update saved source',
    allowedPaths: ['src/app.js'], config: {}, workflow: {},
    verifySavedEditorBuffers: editorProof
  });
  assert.equal(plan.status, 'ready-for-explicit-freeze');
  assert.equal(plan.drift[0].saved.mode, '100644');
  assert.equal(plan.drift[0].candidate.mode, '100644');
});

test('watcher mutation during admission cannot freeze the previewed child', async (t) => {
  const { root, git, parentCandidate } = await fixture(t);
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 3;\n');
  const options = {
    root, subjectId, parentCandidate, note: 'Capture saved update',
    allowedPaths: ['src/app.js'], config: {}, workflow: {},
    verifySavedEditorBuffers: editorProof
  };
  const plan = await planManualRevisionCapture(options);
  const beforeRef = git('rev-parse', parentCandidate.namespace);
  await assert.rejects(freezeManualRevisionCandidate({
    ...options, plan,
    verifyAdmission: async () => {
      await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 4;\n');
      return true;
    },
    createdBy: { kind: 'human', id: 'revision@example.com' }
  }), { code: 'REV_MANUAL_PLAN_STALE' });
  assert.equal(git('rev-parse', parentCandidate.namespace), beforeRef);
});

test('retained candidate from another Story phase is refused before inventory', async (t) => {
  const { root, parentCandidate } = await fixture(t);
  await assert.rejects(planManualRevisionCapture({
    root, subjectId: 'OTHER-STORY:implementation', parentCandidate,
    note: 'Wrong Story', allowedPaths: ['src/app.js'],
    config: {}, workflow: {}, verifySavedEditorBuffers: editorProof
  }), { code: 'REV_MANUAL_PARENT_UNVERIFIED' });
});
