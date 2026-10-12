import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Amend Tester', SINGULARITY_FLOW_NO_MODEL: '1' };
const W = 'AMEND-FWD-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A document-only Story: intake, then design reading intake, then fix-design reading both. */
async function documentStory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-forward-amendment-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Amend Tester'], root);
  run('git', ['config', 'user.email', 'amend-fwd@example.test'], root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/smoke.test.mjs'), "import test from 'node:test';\ntest('smoke', () => {});\n");
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['document-chain'] = {
    label: 'Document chain', phases: ['intake', 'design', 'fix-design'],
    phaseOverrides: { design: { inputs: ['intake'] }, 'fix-design': { inputs: ['intake', 'design'], approval: { rejectTo: ['intake', 'design', 'fix-design'] } } },
    spec: { mode: 'off', coverage: 'off' },
    // A documents-only fixture: these responsibilities are decided not to apply before it closes.
    omits: ['scope', 'plan', 'implement', 'verify'].map((responsibility) => ({ responsibility,
      reason: `This document-only fixture exercises forward amendment and has no ${responsibility} step.`, authority: 'quality-reviewers' }))
  };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the forward amendment fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'document-chain', '--title', 'Cache the value', '--description', 'Decide how long callers cache the value.');
  const item = path.join(root, 'singularity/work-items', W);
  const artifact = (phase) => path.join(item, `artifacts/${phase}/${phase}.md`);
  const author = async (phase, text) => {
    cli('prepare', phase);
    const file = artifact(phase);
    await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, text));
  };
  const complete = (phase) => {
    cli('wm', 'compose', '--phase', phase);
    cli('clarification', 'record', phase, '--question', `Is the ${phase} scope agreed?`, '--answer', 'Yes, as written.');
    cli('phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place');
    cli('submit', phase);
    cli('approve', phase, '--yes');
  };
  await author('intake', 'Callers read the value from one shared module and may keep a copy for a while.');
  complete('intake');
  await author('design', 'A single module exposes the value; callers keep a local copy and refresh it on change.');
  complete('design');
  await author('fix-design', 'The fix keeps the shared module and documents when callers refresh their copy.');
  const state = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { root, cli, attempt, state, artifact };
}

test('an approved earlier document is amended in place; a later step keeps its approval once revalidated', async (t) => {
  const { root, cli, attempt, state, artifact } = await documentStory(t);
  const intake = artifact('intake');
  const approved = await readFile(intake, 'utf8');
  // The intake's approver corrects it in the working tree and proposes the correction.
  await writeFile(intake, `${approved.trimEnd()}\n\nCallers keep their copy for at most one hour.\n`);
  const reason = 'The intake never bounded how long callers keep their copy of the value.';
  const proposed = JSON.parse(cli('upstream-issue', 'propose-amendment', '--phase', 'intake', '--reason', reason, '--json').stdout).data.proposal;
  assert.equal(proposed.id, 'FAM-001');
  assert.equal(await readFile(intake, 'utf8'), approved, 'the approved bytes stay in force until the approvers decide');
  assert.match(await readFile(path.join(root, proposed.proposedPath), 'utf8'), /at most one hour/u);
  const refusedCode = attempt('upstream-issue', 'propose-amendment', '--phase', 'fix-design', '--reason', reason);
  assert.match(refusedCode.stdout + refusedCode.stderr, /earlier step/u);
  const unconfirmed = attempt('upstream-issue', 'decide-amendment', 'FAM-001', '--decision', 'approve', '--reason', reason);
  assert.match(unconfirmed.stdout + unconfirmed.stderr, /--confirm FAM-001/u);

  const decided = attempt('upstream-issue', 'decide-amendment', 'FAM-001', '--decision', 'approve', '--reason', 'One hour matches the platform cache policy.', '--confirm', 'FAM-001', '--json');
  assert.equal(decided.status, 0, decided.stdout + decided.stderr);
  const result = JSON.parse(decided.stdout).data;
  assert.deepEqual(result.revalidate, ['design']);
  assert.equal(result.refreshed, 'fix-design');
  const after = await state();
  assert.equal(after.phases.intake.generation, 2);
  assert.equal(after.phases.intake.status, 'approved');
  assert.equal(after.phases.design.status, 'approved', 'design keeps its approval');
  assert.equal(after.phases.design.generation, 1, 'and is not reset');
  assert.equal(after.phases['fix-design'].status, 'in_progress');
  assert.match(await readFile(intake, 'utf8'), /at most one hour/u);
  assert.match(await readFile(artifact('fix-design'), 'utf8'), /at most one hour/u, 'the current draft reads the amended intake');
  assert.match(await readFile(artifact('fix-design'), 'utf8'), /documents when callers refresh their copy/u, 'and keeps its text');

  // Until design is revalidated the governance gate says how.
  const gate = attempt('gate', '--json');
  assert.notEqual(gate.status, 0);
  assert.match(gate.stdout + gate.stderr, /upstream-issue revalidate design --work-id AMEND-FWD-1 --amendment FAM-001/u);
  const revalidated = attempt('upstream-issue', 'revalidate', 'design', '--amendment', 'FAM-001', '--outcome', 'unchanged',
    '--reason', 'The design already refreshes on change; the one-hour bound does not alter it.');
  assert.equal(revalidated.status, 0, revalidated.stdout + revalidated.stderr);
  const gated = attempt('gate', '--json');
  assert.doesNotMatch(gated.stdout + gated.stderr, /design (?:phase-input record|artifact managed-input block|was revalidated)/u);
  assert.match(gated.stdout + gated.stderr, /phase inputs revalidated: design after FAM-001/u);

  cli('wm', 'compose', '--phase', 'fix-design');
  cli('clarification', 'record', 'fix-design', '--question', 'Is the fix-design scope agreed?', '--answer', 'Yes, as written.');
  for (const responsibility of ['scope', 'plan', 'implement', 'verify']) {
    cli('decision', 'applicability', '--responsibility', responsibility, '--reason', `This document-only Story has no ${responsibility} step by design.`);
  }
  cli('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'fix-design');
  const approval = attempt('approve', 'fix-design', '--yes');
  assert.equal(approval.status, 0, approval.stdout + approval.stderr);
  const done = await state();
  assert.equal(done.status, 'closed');
  assert.deepEqual(done.history.filter((entry) => /forward_amendment|amendment_revalidated/u.test(entry.event)).map((entry) => entry.event),
    ['forward_amendment_proposed', 'forward_amendment_approved', 'amendment_revalidated']);
});

test('a later step that no longer holds under the amendment is returned to, and owes nothing more', async (t) => {
  const { cli, attempt, state, artifact } = await documentStory(t);
  const intake = artifact('intake');
  await writeFile(intake, `${(await readFile(intake, 'utf8')).trimEnd()}\n\nCallers never keep a copy.\n`);
  cli('upstream-issue', 'raise', '--phase', 'intake', '--about', 'Caching', '--problem', 'The intake lets callers keep a copy the platform forbids.');
  cli('upstream-issue', 'propose-amendment', '--phase', 'intake', '--issue', 'UPI-001', '--reason', 'Callers may not keep any copy of the value under the platform rules.');
  cli('upstream-issue', 'decide-amendment', 'FAM-001', '--decision', 'approve', '--reason', 'The platform forbids local copies outright.', '--confirm', 'FAM-001');
  const closed = attempt('upstream-issue', 'decide', 'UPI-001', '--outcome', 'amend', '--link', 'FAM-001', '--reason', 'The approved amendment removes the local copy.');
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  const returned = attempt('upstream-issue', 'revalidate', 'design', '--amendment', 'FAM-001', '--outcome', 'return',
    '--reason', 'The design is built around a local copy, so it must be redone.');
  assert.equal(returned.status, 0, returned.stdout + returned.stderr);
  const after = await state();
  assert.equal(after.currentPhase, 'design');
  assert.equal(after.phases.design.status, 'in_progress');
  assert.equal(after.phases['fix-design'].status, 'not_started');
  assert.equal(after.phases.intake.generation, 2, 'the amended intake stays');
  const request = after.changeRequests.at(-1);
  assert.equal(request.forwardAmendment, 'FAM-001');
  assert.deepEqual(after.amendmentRevalidations.map((entry) => [entry.phase, entry.outcome, entry.link]), [['design', 'return', request.id]]);
  assert.deepEqual(after.upstreamIssueDecisions.map((entry) => [entry.issue, entry.outcome, entry.link]), [['UPI-001', 'amend', 'FAM-001']]);
  const again = attempt('upstream-issue', 'revalidate', 'design', '--amendment', 'FAM-001', '--outcome', 'unchanged', '--reason', 'Trying to revalidate a reset step.');
  assert.match(again.stdout + again.stderr, /no revalidation owed/u);
});
