import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectDraftEvidenceHold } from '../src/draft-evidence-hold.mjs';
import { inspectLifecycleWorktree } from '../src/lifecycle-worktree.mjs';
import { snapshot } from '../src/util.mjs';

async function fixture(t, phaseId = 'custom-authoring') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-hold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Evidence Tester'); git('config', 'user.email', 'evidence@example.invalid');
  const itemRoot = 'team/stories/HOLD-1';
  const input = `${itemRoot}/artifacts/approved.md`;
  await mkdir(path.join(root, itemRoot, 'artifacts'), { recursive: true });
  await writeFile(path.join(root, input), '# Approved input\n');
  git('add', '.'); git('commit', '-qm', 'approved input');
  const phase = { id: phaseId, status: 'in_progress', generation: 0, generationPolicy: { task: 'specify', requirement: 'required' } };
  const config = { workItemRoot: 'team/stories' };
  const workflow = { status: 'in_progress', currentPhase: phaseId, workItem: { id: 'HOLD-1' },
    phaseOrder: ['owner', phaseId], resolution: { plannedClaims: { owners: { [phaseId]: 'owner' } } },
    phases: { owner: { id: 'owner', status: 'approved', generation: 1,
      artifacts: [{ path: input, ...await snapshot(path.join(root, input)) }] }, [phaseId]: phase } };
  const evidencePath = `${itemRoot}/evidence/screen.png`;
  await mkdir(path.dirname(path.join(root, evidencePath)), { recursive: true });
  await writeFile(path.join(root, evidencePath), 'Retained bytes, not accepted proof.');
  const inspect = (overrides = {}) => inspectDraftEvidenceHold(root, config, workflow, phase, {
    unexpectedPaths: [evidencePath], expectedPaths: [], simpleStatus: true,
    inspection: inspectLifecycleWorktree(root, config, workflow), ...overrides
  });
  return { root, git, input, evidencePath, config, workflow, phase, inspect };
}

test('exact pending evidence is held read-only for built-in and future phase names', async t => {
  for (const id of ['specification', 'planning', 'implementation', 'verification', 'release', 'custom-document-step']) {
    const f = await fixture(t, id);
    const before = { index: f.git('ls-files', '--stage'), status: f.git('status', '--porcelain=v1', '--untracked-files=all'),
      evidence: await readFile(path.join(f.root, f.evidencePath)) };
    const result = await f.inspect();
    assert.equal(result.allowed, true, id); assert.equal(result.status, 'draft-only');
    assert.equal(result.phaseId, id); assert.equal(result.generation, 1);
    assert.equal(result.evidenceAccepted, false); assert.equal(result.testsWaived, false);
    assert.equal(result.publicationReviewRequired, true);
    assert.deepEqual(result.heldEvidence.map(entry => entry.path), [f.evidencePath]);
    assert.match(result.heldEvidence[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(f.git('ls-files', '--stage'), before.index); assert.equal(f.git('status', '--porcelain=v1', '--untracked-files=all'), before.status);
    assert.deepEqual(await readFile(path.join(f.root, f.evidencePath)), before.evidence);
  }
});

test('holds reject unknown owners, unrelated paths, unsafe operations, stages, links and protected evidence', async t => {
  const f = await fixture(t);
  assert.equal(await f.inspect({ simpleStatus: false }), null);
  assert.equal(await f.inspect({ unexpectedPaths: [f.evidencePath, 'README.md'] }), null);
  assert.equal(await f.inspect({ unexpectedPaths: ['team/stories/OTHER/evidence/screen.png'] }), null);
  f.config.governance = { protectedPaths: [f.evidencePath] };
  assert.equal(await f.inspect(), null); delete f.config.governance;
  f.workflow.phases.owner.status = 'in_progress'; assert.equal(await f.inspect(), null);
  f.workflow.phases.owner.status = 'approved';
  f.git('add', f.evidencePath); assert.equal(await f.inspect(), null);
  f.git('restore', '--staged', f.evidencePath);
  const linked = 'team/stories/HOLD-1/evidence/linked.png';
  await symlink(path.join(f.root, f.input), path.join(f.root, linked));
  assert.notEqual((await f.inspect({ unexpectedPaths: [linked] }))?.allowed, true);
  assert.equal(await f.inspect({ unexpectedPaths: [f.evidencePath, 'team/stories/HOLD-1/evidence/../forged.png'] }), null);
});

test('published work, missing code intent, changed approved inputs and oversized evidence cannot use draft holds', async t => {
  const f = await fixture(t);
  f.phase.status = 'awaiting_approval'; assert.equal(await f.inspect(), null);
  f.phase.status = 'in_progress'; f.phase.generation = 1;
  f.phase.generationIntent = { status: 'consumed', generation: 1 };
  assert.equal(await f.inspect(), null);
  f.phase.generation = 0; delete f.phase.generationIntent;
  f.phase.generationPolicy.task = 'code'; f.phase.writeScope = 'source-and-artifact';
  assert.equal((await f.inspect()).allowed, false);
  f.phase.generationPolicy.task = 'specify';
  f.git('update-index', '--assume-unchanged', f.input);
  await writeFile(path.join(f.root, f.input), '# Hidden changed approved input\n');
  assert.equal((await f.inspect()).allowed, false);
  f.git('update-index', '--no-assume-unchanged', f.input);
  await writeFile(path.join(f.root, f.input), '# Tampered approved input\n');
  assert.equal((await f.inspect()).code, 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY');
  await writeFile(path.join(f.root, f.input), '# Approved input\n');
  await writeFile(path.join(f.root, f.evidencePath), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal((await f.inspect()).allowed, false);
});
