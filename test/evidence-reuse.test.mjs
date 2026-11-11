/**
 * Reusing a run an earlier step recorded (`decision evidence-reuse`), against real retained records.
 *
 * The incident: Verification ran the tests by hand and wrote the result, but its packet recorded no
 * run; the only recorded run was Implementation's. A person who approves Verification may reuse that
 * run while the source is unchanged, and it must always read as Implementation's run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig, sourceTreeHash, testInputTreeHash } from '../src/state.mjs';
import { createStoryReviewPacket } from '../src/story-lineage.mjs';
import { snapshot } from '../src/util.mjs';
import { buildTestExecutionReceipt } from '../src/code-delivery-tests.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { requireApprovalAuthority } from '../src/approval-authority.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { phaseExecutionEvidence, renderExecutionEvidence } from '../src/phase-execution-evidence.mjs';
import { projectEvidenceConsistency, renderEvidenceConsistency } from '../src/evidence-consistency.mjs';
import { activeEvidenceReuse, evidenceReuseDecisionCommand, evidenceReuseFor, evidenceReuseState,
  observeEvidenceReuseSource, prepareEvidenceReuse, recordEvidenceReuse, recordEvidenceReuseRevocation,
  verifyReusableAttempt } from '../src/evidence-reuse.mjs';
import { evidenceReuseAuthorities } from '../src/commands/decision-evidence-reuse.mjs';

const WORK = 'REUSE-1';
const ATTEMPT = 'TA-0123456789abcdef0123';
const AT = () => new Date().toISOString();
const REASON = 'Implementation recorded this suite on the same source; nothing changed since.';
const person = { actor: 'quality.reviewer@example.invalid', authorityGroup: 'quality-reviewers', identityAssurance: 'configured-local' };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

/** A Story whose approved Implementation retained one structured attempt in its submission packet. */
async function fixture(t, { counts = { discovered: 33, passed: 33, failed: 0, skipped: 0 }, status = 'passed', exitCode = 0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Evidence Reuse Test');
  git(root, 'config', 'user.email', 'evidence.reuse@example.invalid');
  await initializeDefinition(root);
  await writeFile(path.join(root, 'app.js'), 'export const hex = n => n.toString(16);\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'repository fixture');
  git(root, 'switch', '-qc', WORK);
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, { id: WORK, title: 'Reuse a recorded run',
    baseBranch: 'main', workType: 'spec-driven-standard', agent: 'product-owner',
    resolved: resolveWorkType(config, 'spec-driven-standard'), source: { type: 'manual', key: WORK,
      title: 'Reuse a recorded run', description: 'Verification cites the run Implementation recorded.',
      acceptanceCriteria: ['Reused evidence is labelled as the recording step\'s run.'] } });
  const producer = workflow.phases.implementation;
  const item = `singularity/work-items/${WORK}`;
  const summary = `${item}/${producer.requiredArtifact.path}`;
  await mkdir(path.dirname(path.join(root, summary)), { recursive: true });
  await writeFile(path.join(root, summary), '# Implementation summary\n\nThe hex helper is delivered.\n');
  producer.artifacts = [{ path: summary, kind: 'implementation-summary', ...await snapshot(path.join(root, summary)) }];
  Object.assign(producer, { status: 'approved', generation: 1 });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'candidate fixture');
  producer.generationCommit = git(root, 'rev-parse', 'HEAD');
  producer.checks = [{ id: 'vitest', kind: 'test', status: status === 'passed' ? 'passed' : 'failed', exitCode,
    sourceCommit: producer.generationCommit, sourceTreeSha256: await sourceTreeHash(root, config, workflow),
    testInputSha256: await testInputTreeHash(root, config, workflow),
    startedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z', workingDirectory: '.', stdout: '', stderr: '' }];
  const attemptPath = `${item}/context/code-delivery/tests/attempts/implementation/${ATTEMPT}.json`;
  const command = { id: 'vitest', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'vitest-json', path: '.sflow/results/vitest.json' } };
  const attempt = buildTestExecutionReceipt(command, producer.checks[0], { adapter: 'vitest-json', tests: counts,
    minimumDiscovered: 1, minimumPassed: 1, result: { path: '.sflow/results/vitest.json' } }, {
    attemptId: ATTEMPT, nonce: 'fixture-nonce', workId: WORK, phase: producer.id, generation: 1 });
  await mkdir(path.dirname(path.join(root, attemptPath)), { recursive: true });
  await writeFile(path.join(root, attemptPath), canonicalJson(attempt));
  // The ready delivery receipt binds which clause this command's tests cover.
  const receiptPath = `${item}/context/code-delivery/implementation-gen1.json`;
  const receipt = { schemaVersion: currentSchemaVersion('code-delivery'), kind: 'code-delivery', status: 'ready', workId: WORK, phase: producer.id, generation: 1,
    traceability: { bindings: [{ clauseId: `${WORK}:AC-001`, testSource: 'app.test.js', commandId: 'vitest' },
      { clauseId: `${WORK}:AC-009`, testSource: 'other.test.js', commandId: 'other-command' }], witnesses: [] } };
  await writeFile(path.join(root, receiptPath), canonicalJson(receipt));
  producer.deliveryEvidence = { status: 'ready', receiptPath, receiptSha256: recordSha256(receipt),
    testExecutions: [{ commandId: command.id, attemptId: ATTEMPT, receiptPath: attemptPath,
      receiptSha256: recordSha256(attempt), status: attempt.status }] };
  // Fixture setup only: retain a real writer-produced, content-addressed review packet in Git.
  const submission = await createStoryReviewPacket(root, config, workflow, producer);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'retain submission fixture');
  const phase = workflow.phases.verification;
  for (const id of ['specification', 'planning', 'convergence']) workflow.phases[id].status = 'approved';
  workflow.currentPhase = phase.id; phase.status = 'in_progress';
  return { root, config, workflow, phase, producer, submission, attemptPath, attempt };
}

async function decide(item, phaseId = 'verification') {
  const prepared = await prepareEvidenceReuse(item.root, item.config, item.workflow, { phaseId, attemptId: ATTEMPT });
  return recordEvidenceReuse(item.workflow, { phaseId, candidate: prepared, reason: REASON, ...person, at: AT() });
}

async function commitChange(item, file, text) {
  await writeFile(path.join(item.root, file), text);
  git(item.root, 'add', file); git(item.root, 'commit', '-qm', `change ${file}`);
}

test('an unchanged source lets a step approver reuse the recorded run, bound and labelled as the recording step\'s', async (t) => {
  const item = await fixture(t);
  const decision = await decide(item);
  assert.equal(decision.id, 'ERU-001');
  assert.equal(decision.phase, 'verification');
  assert.deepEqual(decision.attempt, { id: ATTEMPT, sha256: recordSha256(item.attempt), path: item.attemptPath,
    phase: 'implementation', generation: 1, commandId: 'vitest', status: 'passed',
    tests: { discovered: 33, passed: 33, failed: 0, skipped: 0 }, completedAt: '2026-10-12T00:01:00Z' });
  assert.deepEqual(decision.source, { commit: item.producer.generationCommit,
    treeSha256: await sourceTreeHash(item.root, item.config, item.workflow), testInputSha256: null });
  assert.deepEqual(decision.clauses, [`${WORK}:AC-001`], 'only the clauses this command\'s tests cover');
  assert.equal(decision.actor, person.actor);
  assert.equal(decision.authorityGroup, 'quality-reviewers');

  const label = `reused: ${ATTEMPT} recorded by implementation;`
    + ` approved for verification by ${person.actor} (ERU-001), not a run by verification`;
  const reuse = await evidenceReuseFor(item.root, item.config, item.workflow, 'verification');
  assert.equal(reuse.active.length, 1);
  assert.equal(reuse.active[0].label, label);
  assert.equal(reuse.active[0].runByThisStep, false);
  assert.equal(reuse.active[0].recordedBy, 'implementation');
  assert.deepEqual(reuse.clauseIds, [`${WORK}:AC-001`]);
  assert.deepEqual((await evidenceReuseFor(item.root, item.config, item.workflow, 'implementation')).active, [],
    'a decision is for the step that consumes the run');

  // The step's own evidence view: its packet still says it recorded no run, and the reuse says whose run it cites.
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.reusedTestEvidence.length, 1);
  assert.equal(evidence.reusedTestEvidence[0].label, label);
  // The prompt states each reuse label once, in the evidence-consistency section.
  const rendered = renderEvidenceConsistency(projectEvidenceConsistency({ workflow: item.workflow, phase: item.phase, executionEvidence: evidence }));
  assert.ok(rendered.includes(`- Approved reuse: ${label}`), rendered);
  assert.match(rendered, /Earlier runs remain attributed to their producer, even after approved reuse/u);
  assert.doesNotMatch(rendered, /verification (?:ran|executed|passed) /u, 'never says the reusing step ran tests');
  assert.equal(renderExecutionEvidence(evidence).includes(label), false, 'the execution-evidence section does not repeat it');

  // The conformance step's inputs carry the reuse its earlier step decided.
  const release = item.workflow.phases.release;
  item.workflow.currentPhase = release.id; release.status = 'in_progress'; item.phase.status = 'approved';
  const inputs = await phaseExecutionEvidence(item.root, item.config, item.workflow, release);
  assert.equal(inputs.reusedTestEvidence[0].label, label);
  const gate = await evidenceReuseFor(item.root, item.config, item.workflow, 'release', { through: true });
  assert.deepEqual(gate.clauseIds, [`${WORK}:AC-001`]);
  assert.deepEqual((await evidenceReuseFor(item.root, item.config, item.workflow, 'release')).active, [],
    'without through, only the step\'s own decisions');

  // The same attempt cannot be decided twice for the same step while the first stands.
  await assert.rejects(decide(item), { code: 'EVIDENCE_REUSE_ALREADY_RECORDED' });
  // Without a source observation nothing is assumed active.
  assert.equal(activeEvidenceReuse(item.workflow, 'verification', { at: AT() }).active.length, 0);
  assert.match(evidenceReuseDecisionCommand(item.workflow, { phaseId: 'verification', attemptId: ATTEMPT }),
    new RegExp(`^singularity-flow decision evidence-reuse ${WORK} --phase verification --from-attempt ${ATTEMPT} --reason `, 'u'));
});

test('a source file changed after the attempt refuses reuse, naming the path, with repair and fresh-run routes', async (t) => {
  const item = await fixture(t);
  await commitChange(item, 'app.js', 'export const hex = n => `0x${n.toString(16)}`;\n');
  await assert.rejects(prepareEvidenceReuse(item.root, item.config, item.workflow, { phaseId: 'verification', attemptId: ATTEMPT }), (error) => {
    assert.equal(error.code, 'EVIDENCE_REUSE_SOURCE_CHANGED');
    assert.deepEqual(error.details.paths, ['app.js']);
    assert.equal(error.details.sourcePhase, 'implementation');
    assert.match(error.message, /changed after implementation recorded it: app\.js\./u);
    assert.match(error.message, /Repair: return the change to implementation/u);
    assert.match(error.message, /Fresh recorded run: verification has no test command of its own/u);
    assert.equal(error.details.recoveryCommands[0].command, 'singularity-flow reject verification --to implementation --repair --reason <REASON>');
    assert.equal(error.details.nextAction.command, error.details.recoveryCommands[0].command);
    return true;
  });
  // A Story-only change (its own records) is not a source change.
  const other = await fixture(t);
  await commitChange(other, `singularity/work-items/${WORK}/notes.md`, 'Verification notes; not application source.\n');
  assert.equal((await decide(other)).id, 'ERU-001');
});

test('a decision lapses when the source changes after it, and the step is never shown as having run the tests', async (t) => {
  const item = await fixture(t);
  await decide(item);
  const original = await readFile(path.join(item.root, 'app.js'), 'utf8');
  await commitChange(item, 'app.js', 'export const hex = () => "changed";\n');
  const reuse = await evidenceReuseFor(item.root, item.config, item.workflow, 'verification');
  assert.equal(reuse.active.length, 0);
  assert.deepEqual(reuse.clauseIds, [], 'a lapsed decision covers nothing');
  assert.equal(reuse.lapsed[0].state, 'source-changed');
  assert.match(reuse.lapsed[0].label, new RegExp(`^ERU-001 no longer applies \\(the application source or its test inputs changed after that run\\): ${ATTEMPT} was recorded by implementation, and no run by verification is recorded\\.`, 'u'));
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.reusedTestEvidence[0].state, 'source-changed');
  assert.match(renderEvidenceConsistency(projectEvidenceConsistency({ workflow: item.workflow, phase: item.phase, executionEvidence: evidence })),
    /Reuse not active: ERU-001 no longer applies/u);
  assert.equal(item.workflow.evidenceReuses.length, 1, 'lapsing writes nothing');
  // The binding is to bytes: the exact tested source binds again.
  await commitChange(item, 'app.js', original);
  assert.equal((await evidenceReuseFor(item.root, item.config, item.workflow, 'verification')).active.length, 1);
  // Reopening the step that recorded the run supersedes it: the run is no longer that step's retained evidence.
  Object.assign(item.producer, { status: 'in_progress', generation: 2 });
  const superseded = (await evidenceReuseFor(item.root, item.config, item.workflow, 'verification')).lapsed[0];
  assert.equal(superseded.state, 'superseded');
  assert.match(superseded.label, /^ERU-001 no longer applies \(implementation was reopened, so the run is no longer its retained evidence\)/u);
  Object.assign(item.producer, { status: 'approved', generation: 1 });
  // A changed attempt record lapses it as well.
  const record = JSON.parse(await readFile(path.join(item.root, item.attemptPath), 'utf8'));
  await writeFile(path.join(item.root, item.attemptPath), canonicalJson({ ...record, tests: { ...record.tests, passed: 34, discovered: 34 } }));
  assert.equal((await evidenceReuseFor(item.root, item.config, item.workflow, 'verification')).lapsed[0].state, 'attempt-changed');
});

test('revoking a decision ends it; the decision and its revocation both stay', async (t) => {
  const item = await fixture(t);
  await decide(item);
  assert.throws(() => recordEvidenceReuseRevocation(item.workflow, { reuseId: 'ERU-001', reason: 'short', ...person, at: AT() }),
    { code: 'EVIDENCE_REUSE_INVALID' });
  const revocation = recordEvidenceReuseRevocation(item.workflow, { reuseId: 'ERU-001',
    reason: 'Verification will record its own run of the suite instead.', ...person, at: AT() });
  assert.deepEqual({ revokes: revocation.revokes, phase: revocation.phase, attemptId: revocation.attemptId },
    { revokes: 'ERU-001', phase: 'verification', attemptId: ATTEMPT });
  assert.equal(item.workflow.evidenceReuses.length, 2);
  const reuse = await evidenceReuseFor(item.root, item.config, item.workflow, 'verification');
  assert.equal(reuse.active.length, 0);
  assert.equal(reuse.lapsed[0].state, 'revoked');
  assert.match(reuse.lapsed[0].label, /^ERU-001 no longer applies \(it was revoked\)/u);
  assert.throws(() => recordEvidenceReuseRevocation(item.workflow, { reuseId: 'ERU-001',
    reason: 'Verification will record its own run of the suite instead.', ...person, at: AT() }), { code: 'EVIDENCE_REUSE_REVOKED' });
  assert.throws(() => recordEvidenceReuseRevocation(item.workflow, { reuseId: 'ERU-404',
    reason: 'Verification will record its own run of the suite instead.', ...person, at: AT() }), { code: 'EVIDENCE_REUSE_UNKNOWN' });
  // After a revocation the same run may be reused again, as a new decision.
  assert.equal((await decide(item)).id, 'ERU-002');
  // An expiry is optional and bounded; an expired decision lapses.
  const expiring = structuredClone(item.workflow.evidenceReuses.at(-1));
  expiring.expiresAt = '2026-01-01T23:59:59.999Z';
  const observed = await observeEvidenceReuseSource(item.root, item.config, item.workflow);
  assert.equal(evidenceReuseState(item.workflow, expiring, { at: AT(), observed }), 'expired');
});

test('only a retained, passed, structured attempt of an earlier step can be reused', async (t) => {
  const failing = await fixture(t, { status: 'failed', exitCode: 1, counts: { discovered: 33, passed: 32, failed: 1, skipped: 0 } });
  await assert.rejects(verifyReusableAttempt(failing.root, failing.config, failing.workflow, { phaseId: 'verification', attemptId: ATTEMPT }),
    { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /its run is failed, not passed/u });
  const skipped = await fixture(t, { counts: { discovered: 33, passed: 32, failed: 0, skipped: 1 } });
  await assert.rejects(verifyReusableAttempt(skipped.root, skipped.config, skipped.workflow, { phaseId: 'verification', attemptId: ATTEMPT }),
    { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /no skipped test/u });
  const item = await fixture(t);
  const refused = (phaseId, attemptId = ATTEMPT) => verifyReusableAttempt(item.root, item.config, item.workflow, { phaseId, attemptId });
  await assert.rejects(refused('verification', 'TA-ffffffffffffffffffff'), { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /no step of this Story bound it/u });
  await assert.rejects(refused('verification', 'not-an-attempt'), { code: 'EVIDENCE_REUSE_INVALID' });
  await assert.rejects(refused('implementation'), { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /own run/u });
  await assert.rejects(refused('planning'), { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /implementation comes after planning/u });
  item.producer.status = 'awaiting_approval';
  await assert.rejects(refused('verification'), { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /only an approved step's submitted runs/u });
  item.producer.status = 'approved';
  // The record is read at the submission commit; a working-copy edit cannot pass for it.
  await writeFile(path.join(item.root, item.attemptPath), '{"status":"passed"}');
  assert.equal((await refused('verification')).attempt.sha256, recordSha256(item.attempt));
  // A run a test-run risk decision let through had no test executed; it is never a pass to reuse.
  const run = item.workflow.phases.implementation.deliveryEvidence.testExecutions[0];
  run.testRunRisk = { id: 'TRR-001', sha256: `sha256:${'a'.repeat(64)}` };
  await assert.rejects(refused('verification'), { code: 'EVIDENCE_REUSE_NOT_ELIGIBLE', message: /test-run risk decision let it through/u });
});

test('only the approvers of the step that consumes the evidence may decide it', async (t) => {
  const item = await fixture(t);
  assert.deepEqual(evidenceReuseAuthorities(item.workflow, 'verification'), ['quality-reviewers']);
  assert.deepEqual(evidenceReuseAuthorities(item.workflow, 'implementation'), ['engineering-reviewers'],
    'the producing step\'s group is a different one');
  const authorities = { 'engineering-reviewers': { label: 'Engineering', allowAnyGitIdentity: false,
    members: [{ email: 'engineer@example.invalid' }] },
  'quality-reviewers': { label: 'Quality', allowAnyGitIdentity: false, members: [{ email: 'quality.reviewer@example.invalid' }] } };
  const policy = { mode: 'required', authorities: evidenceReuseAuthorities(item.workflow, 'verification'), requiredAuthorities: [], minimum: 1 };
  assert.throws(() => requireApprovalAuthority(authorities, policy, { email: 'engineer@example.invalid' }),
    { code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED' }, 'an approver of the producing step may not decide it');
  assert.equal(requireApprovalAuthority(authorities, policy, { email: 'quality.reviewer@example.invalid' }).authorityGroup, 'quality-reviewers');
});
