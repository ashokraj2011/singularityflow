import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planRevisionCodeChecks } from '../src/revision/code-check-plan.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

test('Code check planner uses only registered commands and binds a verified retained candidate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-code-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'app.txt'), 'before\n');
  git('add', 'app.txt');
  git('commit', '-m', 'baseline');
  await writeFile(path.join(root, 'app.txt'), 'candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'revision@example.com' }
  });
  const candidateReference = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  const base = {
    root, candidateReference,
    phase: { id: 'implementation', generation: 1, qualityCommands: [] },
    proofProfileSha256: H('b'), environmentSha256: H('c')
  };
  const unavailable = await planRevisionCodeChecks(base);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.reason, 'no-registered-code-check');
  assert.equal(unavailable.checks.length, 0);

  const command = {
    id: 'unit-tests', kind: 'test', argv: ['npm', 'test', '--', '--runInBand'],
    modelPolicy: 'never',
    workingDirectory: '.', affectedRoots: ['src', 'test'],
    result: { adapter: 'junit-xml', path: '.sflow/results/unit.xml' }, timeoutMs: 60_000
  };
  const plan = await planRevisionCodeChecks({
    ...base, phase: { ...base.phase, qualityCommands: [command] }
  });
  assert.equal(plan.status, 'review-required');
  assert.equal(plan.checks[0].argv[0], 'npm');
  assert.equal(plan.checks[0].result.minimumDiscovered, 1);
  assert.equal(plan.checks[0].result.minimumPassed, 1);
  assert.match(plan.checks[0].definitionSha256, /^sha256:[a-f0-9]{64}$/);
  const build = await planRevisionCodeChecks({
    ...base, phase: { ...base.phase, qualityCommands: [{
      id: 'web-build', kind: 'compile', modelPolicy: 'never', argv: ['npm', 'run', 'build'],
      workingDirectory: '.', affectedRoots: ['src']
    }] }
  });
  assert.equal(build.checks[0].kind, 'build');
  await assert.rejects(planRevisionCodeChecks({
    ...base, phase: { ...base.phase, qualityCommands: [{ ...command, modelPolicy: 'unknown' }] }
  }), { code: 'REV_CODE_CHECK_PLAN_INVALID' });
  await assert.rejects(planRevisionCodeChecks({
    ...base, candidateReference: { ...candidateReference, candidateSha256: H('d') },
    phase: { ...base.phase, qualityCommands: [command] }
  }), { code: 'REV_CODE_CHECK_PLAN_INVALID' });
  await assert.rejects(planRevisionCodeChecks({
    ...base, phase: { ...base.phase, qualityCommands: [{ ...command, workingDirectory: '../outside' }] }
  }), { code: 'REV_CODE_CHECK_PLAN_INVALID' });
  await assert.rejects(planRevisionCodeChecks({
    ...base, phase: { ...base.phase, qualityCommands: [command, command] }
  }), { code: 'REV_CODE_CHECK_PLAN_INVALID' });
});
