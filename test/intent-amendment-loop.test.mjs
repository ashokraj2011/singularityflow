import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loopIntentAmendmentClauses, loopIntentAmendmentSource
} from '../src/commands/story.mjs';
import { decideIntentAmendment } from '../src/state.mjs';

function workflow() {
  return {
    workItem: { id: 'LOOP-1', workType: 'spec-code-test-loop' },
    currentPhase: 'implementation',
    phases: {
      specification: { status: 'approved', generation: 1 },
      implementation: {
        status: 'in_progress', generation: 0,
        requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md' }
      },
      testing: {
        status: 'not_started', generation: 0,
        requiredArtifact: { path: 'artifacts/testing/testing.md' }
      }
    },
    intentAmendments: []
  };
}

async function seedRepository(root) {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Loop Test');
  git('config', 'user.email', 'loop@example.test');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/value.js'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
}

test('loop amendment source binds the active phase before or after its artifact exists', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-loop-amendment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedRepository(root);
  const artifact = path.join(root, 'singularity/work-items/LOOP-1/artifacts/implementation/implementation-summary.md');
  await mkdir(path.dirname(artifact), { recursive: true });
  const active = workflow();

  const missing = await loopIntentAmendmentSource(root, {}, active, 'implementation');
  assert.equal(missing.artifactPresent, false);
  assert.equal(missing.artifactSha256, null);
  assert.equal(missing.generation, 0);

  await writeFile(artifact, '# Code feedback\n');
  const present = await loopIntentAmendmentSource(root, {}, active, 'implementation');
  assert.equal(present.artifactPresent, true);
  assert.match(present.artifactSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(present.artifactSha256, missing.artifactSha256);

  active.currentPhase = 'testing';
  await assert.rejects(() => loopIntentAmendmentSource(root, {}, active, 'implementation'), {
    code: 'INTENT_AMENDMENT_SOURCE_INVALID'
  });
  active.currentPhase = 'implementation';
  active.phases.specification.status = 'in_progress';
  await assert.rejects(() => loopIntentAmendmentSource(root, {}, active, 'implementation'), {
    code: 'INTENT_AMENDMENT_SOURCE_INVALID'
  });
  active.phases.specification.status = 'approved';
  active.workItem.workType = 'classic-delivery';
  await assert.rejects(() => loopIntentAmendmentSource(root, {}, active, 'implementation'), {
    code: 'INTENT_AMENDMENT_SOURCE_INVALID'
  });
});

test('Testing feedback may propose a spec correction before its review artifact exists', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-loop-testing-amendment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedRepository(root);
  const active = workflow();
  active.currentPhase = 'testing';
  active.phases.implementation.status = 'approved';
  active.phases.testing.status = 'in_progress';
  const source = await loopIntentAmendmentSource(root, {}, active, 'testing');
  assert.equal(source.phaseId, 'testing');
  assert.equal(source.artifactPresent, false);
  assert.equal(source.generation, 0);
  assert.match(source.sourceTreeSha256, /^sha256:[a-f0-9]{64}$/);
});

test('loop amendment discloses exactly the changed governed clauses', () => {
  const diff = { changed: ['LOOP-1:AC-001', 'LOOP-1:REQ-002'] };
  assert.deepEqual(loopIntentAmendmentClauses(diff,
    ['loop-1:req-002', 'LOOP-1:AC-001']), diff.changed);
  assert.throws(() => loopIntentAmendmentClauses(diff, ['LOOP-1:AC-001']), {
    code: 'INTENT_AMENDMENT_CLAUSES_REQUIRED'
  });
  assert.throws(() => loopIntentAmendmentClauses(diff,
    [...diff.changed, 'LOOP-1:REQ-999']), { code: 'INTENT_AMENDMENT_CLAUSES_REQUIRED' });
});

test('amendment authority refuses a stale phase or changed source artifact before decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-loop-amendment-decision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedRepository(root);
  const artifact = path.join(root, 'singularity/work-items/LOOP-1/artifacts/implementation/implementation-summary.md');
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, '# Original Code feedback\n');
  const active = workflow();
  const source = await loopIntentAmendmentSource(root, {}, active, 'implementation');
  active.intentAmendments.push({ id: 'AMD-001', status: 'proposed', proposalSha256: 'proposal-hash' });
  const proposal = { id: 'AMD-001', status: 'proposed', proposalSha256: 'proposal-hash', source };
  const decide = () => decideIntentAmendment(root, {}, active, proposal, { decision: 'approve' });

  active.phases.implementation.generation = 1;
  await assert.rejects(decide, { code: 'INTENT_AMENDMENT_SOURCE_STALE' });
  active.phases.implementation.generation = 0;
  active.phases.implementation.status = 'awaiting_approval';
  await assert.rejects(decide, { code: 'INTENT_AMENDMENT_SOURCE_STALE' });
  active.phases.implementation.status = 'in_progress';
  await writeFile(path.join(root, 'src/value.js'), 'export const value = 2;\n');
  await assert.rejects(decide, { code: 'INTENT_AMENDMENT_SOURCE_STALE' });
  await writeFile(path.join(root, 'src/value.js'), 'export const value = 1;\n');
  await writeFile(artifact, '# Changed Code feedback\n');
  await assert.rejects(decide, { code: 'INTENT_AMENDMENT_SOURCE_STALE' });
  await rm(artifact);
  await assert.rejects(decide, { code: 'INTENT_AMENDMENT_SOURCE_STALE' });

  const missingSource = await loopIntentAmendmentSource(root, {}, active, 'implementation');
  proposal.source = missingSource;
  await writeFile(artifact, '# Newly prepared Code artifact\n');
  await assert.rejects(decide, { code: 'INTENT_AMENDMENT_SOURCE_STALE' });
});
