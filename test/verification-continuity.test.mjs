import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runFirstRunGuide } from '../src/first-run-guide.mjs';
import { loadDefinition } from '../src/config.mjs';
import { runGovernanceGate } from '../src/governance.mjs';
import { verifyPhaseApprovalWaiver } from '../src/approval-waiver.mjs';
import { assertReviewCodeEvidenceFresh } from '../src/delivery-evidence.mjs';
import { readStoryReviewPacket } from '../src/story-lineage.mjs';
import { run } from '../src/util.mjs';

test('first-run completion has replayable authority and verification cannot replace tested bytes', async (t) => {
  const result = await runFirstRunGuide({ keep: true });
  const root = result.repository;
  t.after(() => rm(path.dirname(root), { recursive: true, force: true }));
  const config = await loadDefinition(root);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/TOY-001/workflow.json'), 'utf8'));
  const phase = workflow.phases.verify;
  const git = (...args) => run('git', args, { cwd: root });
  const guard = () => assertReviewCodeEvidenceFresh(root, config, workflow, phase);

  await t.test('automatic completion and the retained waiver satisfy the terminal gate', async () => {
    assert.equal(workflow.phases.implement.approvalPolicy.minimum, 0);
    assert.equal(phase.approvalDisposition, 'policy_waived');
    assert.equal(phase.approvals.length, 0);
    const gate = await runGovernanceGate(root, config, workflow, { terminal: true });
    assert.deepEqual(gate.errors, []);
    assert.ok(gate.passes.includes('policy waiver verified: verify'));
  });

  await t.test('waiver replay refuses changed policy, checks, predicates, digest and generation', async () => {
    for (const change of [
      (value) => { value.approvalPolicy.maximumChangedPaths = 999; },
      (value) => { value.checks[0].status = 'failed'; },
      (value) => { value.approvalWaiver.predicates.checksPassing = false; },
      (value) => { value.approvalWaiver.policySha256 = '0'.repeat(64); },
      (value) => { value.generation += 1; },
      (value) => { value.approvalDisposition = null; }
    ]) {
      const altered = structuredClone(phase);
      change(altered);
      const replay = await verifyPhaseApprovalWaiver(root, config, workflow, altered);
      assert.equal(replay.valid, false, JSON.stringify(altered));
      assert.ok(replay.errors.length);
    }
  });

  await t.test('review permits ordinary project notes and refuses unstaged, staged and committed source changes', async () => {
    await writeFile(path.join(root, 'README.md'), '# Review notes\nThe existing executable test covers the greeting.\n');
    assert.equal((await guard()).sourcePhase, 'implement');
    git('add', 'README.md'); git('commit', '-m', 'Add review notes');
    const file = path.join(root, 'greeting.mjs');
    const approved = await readFile(file, 'utf8');
    await writeFile(file, 'Incorrect untested greeting.\n');
    const refuses = (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
      && error.details.changedPaths.includes('greeting.mjs');
    await assert.rejects(guard, refuses);
    git('add', 'greeting.mjs');
    await assert.rejects(guard, refuses);
    git('commit', '-m', 'Commit an untested source change');
    await assert.rejects(guard, refuses);
    await writeFile(file, approved); git('add', 'greeting.mjs'); git('commit', '-m', 'Restore the tested source');
    assert.equal((await guard()).sourcePhase, 'implement');
  });

  await t.test('new tests and source renamed to documentation still require Code rework', async () => {
    const newTest = path.join(root, 'tests/new.test.mjs');
    await writeFile(newTest, "import test from 'node:test'; test('not executed', () => {});\n");
    await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
      && error.details.changedPaths.includes('tests/new.test.mjs'));
    await rm(newTest);
    await rename(path.join(root, 'greeting.mjs'), path.join(root, 'NOTICE.txt'));
    git('add', 'greeting.mjs', 'NOTICE.txt');
    await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
      && error.details.changedPaths.includes('greeting.mjs'));
    await rename(path.join(root, 'NOTICE.txt'), path.join(root, 'greeting.mjs'));
    git('add', 'greeting.mjs', 'NOTICE.txt');
  });

  await t.test('a review confined to test automation repairs its own tests but never product source', async () => {
    const repairing = structuredClone(workflow);
    Object.assign(repairing, { status: 'in_progress', currentPhase: 'verify' });
    Object.assign(repairing.phases.verify, { status: 'in_progress', sourceBoundary: 'test-automation' });
    const own = (state) => assertReviewCodeEvidenceFresh(root, config, state, state.phases.verify);
    const testFile = path.join(root, 'tests/greeting.test.mjs');
    const tested = await readFile(testFile, 'utf8');
    await writeFile(testFile, `${tested}// Stabilised by the review's own bounded repair.\n`);
    try {
      assert.equal((await own(repairing)).sourcePhase, 'implement');
      await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
        && error.details.changedPaths.includes('tests/greeting.test.mjs'), 'an unrestricted writer still needs Code');
      const consuming = structuredClone(repairing);
      consuming.resolution.phases.find((entry) => entry.id === 'verify').testEvidenceFrom = 'implement';
      await assert.rejects(() => own(consuming), (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE',
        "a review that consumes Code's tests cannot replace them");
      const reading = structuredClone(repairing);
      reading.phases.verify.writeScope = 'artifact-only';
      await assert.rejects(() => own(reading), (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE');
      const greeting = path.join(root, 'greeting.mjs');
      const approved = await readFile(greeting, 'utf8');
      await writeFile(greeting, 'Untested greeting.\n');
      try {
        await assert.rejects(() => own(repairing), (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
          && JSON.stringify(error.details.changedPaths) === '["greeting.mjs"]'
          && /reject verify --to implement --repair/.test(error.details.repairCommand));
      } finally { await writeFile(greeting, approved); }
    } finally { await writeFile(testFile, tested); }
  });

  await t.test('the pinned input proof replaces only the replay of its own submission', async () => {
    const entry = workflow.lineage.submissions.findLast((candidate) => candidate.phase === 'implement');
    const greeting = path.join(root, 'greeting.mjs');
    const approved = await readFile(greeting, 'utf8');
    const proof = { applicationTreeTested: true, sourcePhase: 'implement', packetSha256: entry.packetSha256, evidenceCommit: 'proven' };
    const fresh = (verifiedCodeInput) => assertReviewCodeEvidenceFresh(root, config, workflow, phase, { verifiedCodeInput });
    // A real proof comes from assertPassedCodeDeliveryInput, which refuses any untested byte; here a
    // dirty source shows that the proof, not a second diff, decides.
    await writeFile(greeting, 'Untested greeting.\n');
    try {
      assert.equal((await fresh(proof)).evidenceCommit, 'proven');
      for (const other of [{ ...proof, packetSha256: '0'.repeat(64) }, { ...proof, sourcePhase: 'verify' },
        { ...proof, applicationTreeTested: false }, null]) {
        await assert.rejects(() => fresh(other), (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE');
      }
    } finally { await writeFile(greeting, approved); }
  });

  await t.test('tracked generated-looking paths are source once committed, and recovery commands match lifecycle status', async () => {
    for (const relative of ['build/runtime.mjs', 'coverage/runtime.test.mjs', 'dist/runtime.mjs', 'vendor/runtime.mjs']) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), 'export const untested = true;\n');
      git('add', '-f', relative);
      if (/\.test\.mjs$/u.test(relative)) {
        // Test automation always belongs to the candidate, so an untested test is stale at once.
        await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE' && error.details.changedPaths.includes(relative));
      } else {
        // Staged but uncommitted, a file no plan names never reached the tested candidate [D9].
        assert.equal((await guard()).sourcePhase, 'implement');
      }
      // Committed out of band, it is part of what ships, so the tested evidence is stale.
      git('commit', '-q', '-m', `Commit ${relative} out of band`);
      await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
        && error.details.changedPaths.includes(relative)
        && error.details.repairCommand.includes('reopen TOY-001 --to implement'));
      const active = structuredClone(workflow);
      active.status = 'in_progress'; active.currentPhase = 'verify';
      for (const status of ['in_progress', 'awaiting_approval']) {
        active.phases.verify.status = status;
        await assert.rejects(() => assertReviewCodeEvidenceFresh(root, config, active, active.phases.verify), (error) => {
          assert.match(error.details.repairCommand, /reject verify --to implement/);
          assert.equal(error.details.repairCommand.includes('--repair'), status === 'in_progress');
          return true;
        });
      }
      active.lineage.submissions = active.lineage.submissions.filter((entry) => entry.phase !== 'implement');
      await assert.rejects(() => assertReviewCodeEvidenceFresh(root, config, active, active.phases.verify),
        (error) => error.details.repairCommand === null && /Restore the original governed Code submission/.test(error.message));
      git('reset', '-q', '--hard', 'HEAD~1');
    }
  });

  await t.test('a hash-valid copied submission cannot bless corrupted committed reconciliation evidence', async () => {
    const packet = await readStoryReviewPacket(root, config, workflow);
    const selected = workflow.lineage.submissions.at(-1);
    const raw = JSON.parse(git('show', `${packet.evidenceCommit}:${selected.path}`).stdout);
    const reference = phase.workIntervalReconciliation;
    const report = JSON.parse(git('show', `${packet.evidenceCommit}:${reference.path}`).stdout);
    report.summary.unplanned += 1;
    await writeFile(path.join(root, reference.path), JSON.stringify(report));
    // The counterfeit packet has a valid content hash, so the sealed reconciliation must be
    // independently replayed rather than trusting its summary or the aggregate's waiver flag.
    const { packetSha256: ignored, ...base } = raw;
    base.submittedBy = { ...base.submittedBy, name: 'Counterfeit replay' };
    const digest = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    const relative = selected.path.replace(selected.packetSha256, digest);
    await writeFile(path.join(root, relative), JSON.stringify({ ...base, packetSha256: digest }));
    git('add', reference.path, relative); git('commit', '-m', 'Counterfeit waiver evidence fixture');
    const forged = structuredClone(workflow);
    forged.lineage.submissions[forged.lineage.submissions.length - 1] = { ...selected,
      packetSha256: digest, path: relative };
    const replay = await verifyPhaseApprovalWaiver(root, config, forged, forged.phases.verify);
    assert.equal(replay.valid, false);
    assert.match(replay.errors.join('\n'), /reconciliation hash mismatch/i);
  });
});

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

/** A low-risk quick-fix Story whose verify phase its approval policy may waive. */
async function quickFixStory(t, id, { configure = () => {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-waiver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  const machine = path.join(directory, 'machine');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'tests')); await mkdir(machine);
  const env = { ...process.env, HOME: machine, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Waiver Tester' };
  const execute = (command, args, allowFailure = false) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (...args) => execute('git', args).stdout.trim();
  const flow = (args, allowFailure = false) => execute(process.execPath, [bin, ...args, '--no-model'], allowFailure);
  const source = async (value, { tagged = true } = {}) => {
    await writeFile(path.join(root, 'src/value.mjs'), `${tagged ? `// @clause:${id}:AC-001 returns the approved value\n` : ''}export const value = ${value};\n`);
    await writeFile(path.join(root, 'tests/value.test.mjs'), [
      "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
      ...(tagged ? [`/** @ac:${id}:AC-001 */`] : []), `test('exact value', () => assert.equal(value, ${value}));`, ''
    ].join('\n'));
  };
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  await source(1, { tagged: false });
  git('init', '-b', 'main'); git('config', 'user.name', 'Waiver Tester'); git('config', 'user.email', 'waiver@example.test');
  flow(['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configure(config);
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.'); git('commit', '-m', 'Waiver fixture configuration');
  git('init', '--bare', '-b', 'main', path.join(directory, 'remote.git'));
  git('remote', 'add', 'origin', path.join(directory, 'remote.git')); git('push', '-q', '-u', 'origin', 'main');
  const plan = JSON.parse(flow(['precheck', '--run', '--scope', 'dependency-test', '--json']).stdout).data.plan;
  flow(['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json']);
  const story = path.join(directory, 'story.yml');
  await writeFile(story, YAML.stringify({
    title: 'Waiver lifecycle', description: 'Change one value through the governed quick-fix path.',
    desiredOutcome: 'The value changes exactly.', acceptanceCriteria: ['The exported value equals the approved number.'], risk: 'low', repositoryCount: 1
  }));
  flow(['start', id, '--from-branch', 'main', '--story-file', story, '--work-type', 'quick-fix', '--agent', 'developer']);
  // Quick fix signs off its scope and plan before any code changes.
  flow(['prepare', 'intake']);
  await writeFile(path.join(root, 'singularity/work-items', id, 'artifacts/intake/intake.md'), [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The exported value must change to the approved number.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${id}:AC-001] | The exported value equals the approved number. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`tests/value.test.mjs\` |`, '',
    '## Out of scope', '', 'Nothing but the exported value and its test changes.', ''
  ].join('\n'));
  flow(['wm', 'compose', '--phase', 'intake']);
  flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
  flow(['submit', 'intake']);
  flow(['approve', 'intake', '--yes']);
  const file = path.join(root, 'singularity/work-items', id, 'workflow.json');
  const state = async () => JSON.parse(await readFile(file, 'utf8'));
  const publish = (phase) => { flow(['prepare', phase]); flow(['phase', 'publish', phase, '--authored', 'deterministic']); };
  const complete = async (value) => {
    flow(['prepare', 'implement']); await source(value);
    flow(['phase', 'publish', 'implement', '--authored', 'deterministic']); flow(['submit', 'implement']);
    publish('verify'); return flow(['submit', 'verify']);
  };
  return { root, file, flow, state, publish, source, complete };
}

const gateResult = (result) => JSON.parse(result.stdout);
const holdsDisposition = (phase) => Object.hasOwn(phase, 'approvalDisposition') || Object.hasOwn(phase, 'approvalWaiver');

test('a waiver from an earlier round never outlives rework, and a stale one never fails a phase people approved', async (t) => {
  const { root, file, flow, state, publish, source, complete } = await quickFixStory(t, 'QF-STALE');
  await complete(2);
  let workflow = await state();
  assert.equal(workflow.status, 'closed');
  assert.equal(workflow.phases.verify.approvalDisposition, 'policy_waived');
  const stale = { approvalDisposition: 'policy_waived', approvalWaiver: workflow.phases.verify.approvalWaiver };
  flow(['reopen', '--to', 'implement', '--reason', 'Broaden the fix after review.']);
  workflow = await state();
  for (const id of ['implement', 'verify']) assert.equal(holdsDisposition(workflow.phases[id]), false, `${id} kept its earlier completion`);

  // Round two touches an authorization path, so the policy cannot waive it and people review it.
  flow(['prepare', 'implement']);
  await source(3);
  await mkdir(path.join(root, 'src/auth'), { recursive: true });
  await writeFile(path.join(root, 'src/auth/guard.mjs'), 'export const guarded = true;\n');
  // The plan did not name the guard, so the code step accounts for it before publishing [E2G-027].
  flow(['decision', 'plan', '--add-location', 'QF-STALE:AC-001=src/auth/guard.mjs', '--reason', 'The broadened fix guards the value behind an authorization check.']);
  flow(['phase', 'publish', 'implement', '--authored', 'deterministic']); flow(['submit', 'implement']);
  publish('verify');
  // Older builds kept the record through a reopen; review and approval drop it.
  const leaveStaleRecord = async (change = () => {}) => {
    const value = JSON.parse(await readFile(file, 'utf8'));
    Object.assign(value.phases.verify, structuredClone(stale));
    change(value);
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  await leaveStaleRecord();
  flow(['submit', 'verify']);
  workflow = await state();
  assert.equal(workflow.phases.verify.status, 'awaiting_approval');
  assert.equal(holdsDisposition(workflow.phases.verify), false, 'submission for review kept a waiver it was not granted');
  await leaveStaleRecord();
  flow(['approve', 'verify', '--yes']);
  workflow = await state();
  assert.equal(workflow.status, 'closed');
  assert.equal(holdsDisposition(workflow.phases.verify), false, 'a human approval kept the earlier waiver');
  let gate = gateResult(flow(['gate', '--terminal', '--json']));
  assert.deepEqual(gate.errors, []);
  assert.equal(gate.warnings.some((warning) => /policy waiver/.test(warning)), false);

  // A Story an older build completed this way still carries the record, and its approvals authorize it.
  await leaveStaleRecord();
  gate = gateResult(flow(['gate', '--terminal', '--json']));
  assert.deepEqual(gate.errors, []);
  assert.ok(gate.warnings.some((warning) => /^verify policy waiver record is stale and was not relied on/.test(warning)), gate.warnings.join('\n'));
  // Without those approvals the stale waiver is what would authorize the phase; it never counts as one.
  await leaveStaleRecord((value) => value.phases.verify.approvals.forEach((approval) => { approval.invalidatedAt ??= approval.at; }));
  const refused = flow(['gate', '--terminal', '--json'], true);
  assert.notEqual(refused.status, 0);
  gate = gateResult(refused);
  assert.ok(gate.errors.some((error) => /^verify policy waiver is invalid: /.test(error)), gate.errors.join('\n'));
  assert.ok(gate.errors.some((error) => /^verify has 0 distinct approvals/.test(error)), gate.errors.join('\n'));
});

test('an approval policy that names no policy waives under the default one, and the gate verifies it', async (t) => {
  const { flow, state, complete } = await quickFixStory(t, 'QF-DEFAULT', {
    configure: (config) => { delete config.phases.verify.approval.policy; }
  });
  await complete(2);
  const workflow = await state();
  assert.equal(workflow.phases.verify.approvalPolicy.policy, null);
  assert.equal(workflow.phases.verify.approvalDisposition, 'policy_waived');
  assert.equal(workflow.status, 'closed');
  const gate = gateResult(flow(['gate', '--terminal', '--json']));
  assert.deepEqual(gate.errors, []);
  assert.ok(gate.passes.includes('policy waiver verified: verify'));
});

test('a waiver policy this build cannot evaluate waives nothing, so people review the phase', async (t) => {
  const { flow, state, complete } = await quickFixStory(t, 'QF-UNKNOWN', {
    configure: (config) => { config.phases.verify.approval.policy = 'team-low-risk-v2'; }
  });
  const submitted = await complete(2);
  assert.match(submitted.stderr, /approval policy 'team-low-risk-v2', which this build cannot evaluate/);
  let workflow = await state();
  assert.equal(workflow.phases.verify.status, 'awaiting_approval');
  assert.equal(holdsDisposition(workflow.phases.verify), false);
  flow(['approve', 'verify', '--yes']);
  workflow = await state();
  assert.equal(workflow.status, 'closed');
  assert.deepEqual(gateResult(flow(['gate', '--terminal', '--json'])).errors, []);
});
