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
import { phaseAuthoringContract } from '../src/phase-authoring-contract.mjs';
import { phaseEntryAgentPresentation } from '../src/agent-packet-presentation.mjs';
import { composePhasePrompt } from '../src/worldmodel.mjs';
import { buildTestExecutionReceipt } from '../src/code-delivery-tests.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { phaseExecutionEvidence, projectExecutionPacket, renderExecutionEvidence,
  withExecutionEvidenceRefresh, MAX_EXECUTION_EVIDENCE_BYTES } from '../src/phase-execution-evidence.mjs';

const sha = `sha256:${'a'.repeat(64)}`;
const commit = 'a'.repeat(40);
function sample({ outcome = 'passed', exitCode = 0, testInput = null } = {}) {
  const checks = [{ id: 'vitest', kind: 'test', status: outcome, exitCode,
    sourceCommit: commit, sourceTreeSha256: sha, ...(testInput ? { testInputSha256: testInput } : {}),
    workingDirectory: '.', startedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z',
    stdout: 'SECRET-STDOUT', stderr: 'SECRET-STDERR', command: 'SECRET-ARGV' }];
  const phase = { id: 'team-build', status: 'approved', generation: 1, checks };
  const packet = { workId: 'EVIDENCE-1', phase: phase.id, generation: 1, checks,
    sourceCommit: commit, sourceTreeSha256: sha, testInputSha256: testInput,
    evidenceCommit: commit, packetSha256: 'b'.repeat(64) };
  const current = { status: 'available', sourceTreeSha256: sha, testInputSha256: testInput,
    ancestor: () => true };
  return { phase, packet, current };
}

test('a bound governed pass survives stale narrative and failed IDE discovery without becoming clause acceptance', () => {
  const item = sample();
  const projection = projectExecutionPacket(item.packet, item.phase, item.current);
  assert.equal(projection.checks[0].outcome, 'passed');
  assert.equal(projection.checks[0].binding, 'matched');
  assert.equal(projection.checks[0].commandSuccessReusable, true);
  assert.equal(projection.checks[0].criterionVerdict, 'not-established-by-command-success');
  const text = JSON.stringify(projection);
  assert.doesNotMatch(text, /SECRET|stdout|stderr|argv/);
});

test('changed source/config, missing ancestry and amended command epochs cannot reuse a passing execution', () => {
  for (const change of ['source', 'test-config', 'ancestor', 'missing-source', 'missing-test-config', 'epoch', 'checks', 'unavailable']) {
    const item = sample({ testInput: `sha256:${'c'.repeat(64)}` });
    if (change === 'source') item.current.sourceTreeSha256 = `sha256:${'d'.repeat(64)}`;
    if (change === 'test-config') item.current.testInputSha256 = `sha256:${'d'.repeat(64)}`;
    if (change === 'ancestor') item.current.ancestor = () => false;
    if (change === 'missing-source') delete item.packet.checks[0].sourceTreeSha256;
    if (change === 'missing-test-config') delete item.packet.checks[0].testInputSha256;
    if (change === 'epoch') item.phase.testCommandRevalidation = { state: 'required' };
    if (change === 'checks') item.phase.checks = [];
    if (change === 'unavailable') item.current.status = 'unavailable';
    const check = projectExecutionPacket(item.packet, item.phase, item.current).checks[0];
    assert.equal(check.commandSuccessReusable, false, change);
    assert.notEqual(check.binding, 'matched', change);
  }
  const freshEpoch = sample(); freshEpoch.phase.testCommandRevalidation = { state: 'required' };
  assert.equal(projectExecutionPacket(freshEpoch.packet, freshEpoch.phase, freshEpoch.current,
    { epochVerified: true }).checks[0].commandSuccessReusable, true,
  'a retained, fully verified successor runner epoch is reusable; the old required marker alone is not a blocker');
});

test('failed, unavailable, skipped, timed out, signalled and invalid passing processes remain nonpassing', () => {
  for (const outcome of ['failed', 'blocked', 'unavailable', 'skipped-warning', 'unknown']) {
    const item = sample({ outcome, exitCode: 1 });
    const check = projectExecutionPacket(item.packet, item.phase, item.current).checks[0];
    assert.equal(check.outcome, outcome);
    assert.equal(check.commandSuccessReusable, false);
  }
  for (const change of [{ exitCode: 127 }, { signal: 'SIGTERM' }, { timedOut: true }, { infrastructureUnavailable: true }]) {
    const item = sample(); Object.assign(item.packet.checks[0], change);
    const check = projectExecutionPacket(item.packet, item.phase, item.current).checks[0];
    assert.equal(check.outcome, 'invalid');
    assert.equal(check.commandSuccessReusable, false);
  }
});

test('not required in one packet is not no upstream execution; omission is explicit', () => {
  const item = sample(); item.packet.checks = [];
  assert.equal(projectExecutionPacket(item.packet, item.phase, item.current).status, 'no-governed-tests-in-this-packet');
  const many = sample(); many.packet.checks = Array.from({ length: 50 }, () => many.packet.checks[0]);
  const projected = projectExecutionPacket(many.packet, many.phase, many.current);
  assert.equal(projected.checks.length, 8);
  assert.equal(projected.omittedChecks, 42);
});

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture(t, { structured = false, counts = { discovered: 33, passed: 33, failed: 0, skipped: 0 } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-execution-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Execution Handoff Test');
  git(root, 'config', 'user.email', 'evidence@example.invalid');
  await initializeDefinition(root);
  await writeFile(path.join(root, 'app.js'), 'export const hex = n => n.toString(16);\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'repository fixture');
  git(root, 'switch', '-qc', 'EVIDENCE-1');
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, { id: 'EVIDENCE-1', title: 'Bind execution facts',
    baseBranch: 'main', workType: 'spec-driven-standard', agent: 'product-owner',
    resolved: resolveWorkType(config, 'spec-driven-standard'), source: { type: 'manual', key: 'EVIDENCE-1',
      title: 'Bind execution facts', description: 'Keep IDE discovery separate from governed execution.',
      acceptanceCriteria: ['A later phase receives retained command facts, not invented passes.'] } });
  const producer = workflow.phases.implementation;
  const relative = `singularity/work-items/EVIDENCE-1/${producer.requiredArtifact.path}`;
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), '# Agent brief\n\nInitial command failed 127: vitest not found.\n');
  producer.artifacts = [{ path: relative, kind: 'implementation-summary', ...await snapshot(path.join(root, relative)) }];
  Object.assign(producer, { status: 'approved', generation: 1 });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'candidate fixture');
  producer.generationCommit = git(root, 'rev-parse', 'HEAD');
  producer.checks = [{ id: 'vitest', kind: 'test', status: 'passed', exitCode: 0,
    sourceCommit: producer.generationCommit, sourceTreeSha256: await sourceTreeHash(root, config, workflow),
    testInputSha256: await testInputTreeHash(root, config, workflow),
    startedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z', workingDirectory: '.',
    stdout: 'SECRET-STDOUT', stderr: '' }];
  if (structured) {
    const relative = 'singularity/work-items/EVIDENCE-1/context/code-delivery/tests/attempts/implementation/TA-01234567890123456789.json';
    const command = { id: 'vitest', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
      result: { adapter: 'vitest-json', path: '.sflow/results/vitest.json' } };
    const receipt = buildTestExecutionReceipt(command, producer.checks[0], { adapter: 'vitest-json', tests: counts,
      minimumDiscovered: 1, minimumPassed: 1, result: { path: '.sflow/results/vitest.json' } }, {
      attemptId: 'TA-01234567890123456789', nonce: 'fixture-nonce', workId: 'EVIDENCE-1',
      phase: producer.id, generation: 1 });
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), canonicalJson(receipt));
    producer.deliveryEvidence = { testExecutions: [{ commandId: command.id, receiptPath: relative,
      receiptSha256: recordSha256(receipt), status: receipt.status }] };
  }
  // Fixture setup only: retain a real writer-produced, content-addressed review packet in Git.
  const submission = await createStoryReviewPacket(root, config, workflow, producer);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'retain submission fixture');
  const phase = workflow.phases.release;
  workflow.currentPhase = phase.id; phase.status = 'in_progress';
  return { root, config, workflow, phase, producer, submission };
}

test('actual immutable packet handoff ignores altered local reports; source change removes reuse, not history', async t => {
  const item = await fixture(t);
  const before = git(item.root, 'status', '--porcelain=v1');
  const packetBytes = await readFile(path.join(item.root, item.submission.path));
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.entries.length, 1);
  assert.equal(evidence.entries[0].checks[0].commandSuccessReusable, true);
  assert.equal(evidence.entries[0].checks[0].structuredTestsReusable, false,
    'a successful command without a retained parsed report is not a verified test suite');
  assert.equal(evidence.entries[0].packetSha256, item.submission.packet.packetSha256);
  assert.match(renderExecutionEvidence(evidence), /IDE "No tests found"/);
  assert.match(renderExecutionEvidence(evidence), /preserve approved reports/i);
  assert.doesNotMatch(renderExecutionEvidence(evidence), /SECRET-STDOUT|vitest not found/);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), before, 'projection writes nothing');
  await writeFile(path.join(item.root, item.submission.path), '{"checks":[{"status":"failed"}]}');
  const uncommitted = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(uncommitted.entries[0].checks[0].outcome, 'passed', 'read exact committed packet, not mutable JSON');
  await writeFile(path.join(item.root, 'app.js'), 'export const hex = () => "broken";\n');
  git(item.root, 'add', 'app.js'); git(item.root, 'commit', '-qm', 'change tested application');
  const changed = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(changed.entries[0].checks[0].binding, 'stale');
  assert.equal(changed.entries[0].checks[0].outcome, 'passed', 'historical execution is not rewritten');
  assert.equal(changed.entries[0].checks[0].commandSuccessReusable, false);
  assert.deepEqual(git(item.root, 'show', `HEAD:${item.submission.path}`), packetBytes.toString().trim());
});

test('retained structured counts survive discovery failures; zero tests and skips never become a fresh test pass', async t => {
  for (const counts of [{ discovered: 33, passed: 33, failed: 0, skipped: 0 },
    { discovered: 0, passed: 0, failed: 0, skipped: 0 }, { discovered: 33, passed: 32, failed: 0, skipped: 1 }]) {
    const item = await fixture(t, { structured: true, counts });
    const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
    assert.deepEqual(evidence.diagnostics, []);
    const check = evidence.entries[0].checks[0];
    assert.equal(check.outcome, 'passed', 'process result remains distinct from discovered tests');
    assert.deepEqual(check.testResult.counts, counts);
    assert.equal(check.structuredTestsReusable, counts.discovered === 33 && counts.skipped === 0);
    assert.equal(check.criterionVerdict, 'not-established-by-command-success');
  }
});

test('future generations, foreign packets, missing history and raw workflow checks never fabricate evidence', async t => {
  const item = await fixture(t);
  item.workflow.lineage.submissions.push({ ...item.workflow.lineage.submissions[0], phase: item.phase.id,
    generation: item.phase.generation, packetSha256: item.submission.packet.packetSha256 });
  let evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.ok(evidence.diagnostics.some(entry => entry.phase === item.phase.id));
  assert.equal(evidence.entries.length, 1, 'foreign packet not borrowed into another phase');
  item.producer.generation = 2;
  evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.entries.length, 0, 'generation 1 is not evidence for generation 2');
  item.workflow.lineage.submissions = [];
  evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.entries.length, 0, 'raw phase checks are not retained evidence');
  assert.equal(evidence.current.status, 'not-needed');
  item.producer.generation = 1;
  item.workflow.lineage.submissions = [{ phase: item.producer.id, generation: 1,
    packetSha256: item.submission.packet.packetSha256, path: 'singularity/work-items/EVIDENCE-1/submissions/missing.json' }];
  evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.entries.length, 0);
  assert.equal(evidence.diagnostics[0].status, 'unavailable', 'missing history remains unavailable, not passed');
});

test('custom future phases share the contract and safe correction routes; refresh preserves canonical prompt bytes', async t => {
  const item = await fixture(t);
  const custom = { ...item.phase, id: 'team-close', approvalPolicy: { rejectTo: ['implementation'] } };
  item.workflow.phases[custom.id] = custom;
  item.workflow.phaseOrder.push(custom.id); item.workflow.currentPhase = custom.id;
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, custom);
  assert.equal(evidence.entries[0].checks[0].commandSuccessReusable, true);
  assert.equal(evidence.reconciliation.currentDraft.copilotCommand, '/sf-appeal');
  assert.deepEqual(evidence.reconciliation.humanReturns, [], 'unsubmitted drafts do not offer a premature rejection');
  custom.status = 'awaiting_approval';
  const submitted = await phaseExecutionEvidence(item.root, item.config, item.workflow, custom);
  assert.equal(submitted.reconciliation.currentDraft, null, 'submitted generations do not offer direct draft edits');
  assert.equal(submitted.reconciliation.humanReturns[0].commandGuidance.copilotCommand, '/sf-reject');
  assert.equal(evidence.reconciliation.approvedRecordsImmutable, true);
  assert.equal(phaseAuthoringContract(item.config, item.workflow, custom).executionEvidence.discoveryIsExecution, false);
  const guide = phaseEntryAgentPresentation({ retainedExecutionEvidence: evidence });
  assert.ok(guide.agentGuide.readOrder.includes('retainedExecutionEvidence'));
  assert.match(guide.agentGuide.instruction, /not absence of upstream execution/);
  const oldPrompt = '# Canonical generation prompt\n';
  const refreshed = withExecutionEvidenceRefresh(oldPrompt, {}, evidence);
  assert.ok(refreshed.startsWith(oldPrompt));
  assert.match(refreshed, /Current execution-evidence refresh/);
  assert.equal(withExecutionEvidenceRefresh(oldPrompt, { promptBudget: { executionEvidence: {
    projectionSha256: evidence.projectionSha256 } } }, evidence), oldPrompt, 'unchanged projection is not repeated');
  assert.ok(Buffer.byteLength(JSON.stringify({ current: evidence.current, entries: evidence.entries,
    diagnostics: evidence.diagnostics })) <= MAX_EXECUTION_EVIDENCE_BYTES);
});

test('long custom workflows retain the test producer ahead of document-only phases without borrowing foreign packets', async t => {
  const item = await fixture(t);
  for (let index = 0; index < 12; index++) {
    const id = `team-document-${index}`;
    item.workflow.phases[id] = { id, status: 'approved', generation: 1, checks: [] };
    item.workflow.phaseOrder.push(id);
    // Foreign no-test packet hints are deliberately invalid; the selector may never admit them.
    item.workflow.lineage.submissions.push({ ...item.workflow.lineage.submissions[0], phase: id });
  }
  item.workflow.currentPhase = item.workflow.phaseOrder.at(-1);
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow,
    item.workflow.phases[item.workflow.currentPhase]);
  assert.equal(evidence.entries.length, 1);
  assert.equal(evidence.entries[0].phase, 'implementation');
  assert.equal(evidence.entries[0].checks[0].commandSuccessReusable, true);
  assert.equal(evidence.omittedPackets, 5);
  assert.equal(evidence.diagnostics.length, 7, 'foreign packets stay diagnostics, not evidence');
});

test('new composed prompts carry bounded evidence and cached reuse preserves the immutable prompt', async t => {
  // Compose a specification fixture without upstream packets: even no-execution is explicit,
  // not an instruction to mark all Story tests unavailable or run an arbitrary IDE tool.
  const item = await fixture(t);
  item.workflow.currentPhase = 'specification';
  await writeFile(path.join(item.root, 'singularity/work-items/EVIDENCE-1/workflow.json'), JSON.stringify(item.workflow));
  const prompt = await composePhasePrompt(item.root, { workId: 'EVIDENCE-1', phase: 'specification', agent: 'product-owner' });
  assert.match(prompt, /# Governed execution evidence/);
  assert.match(prompt, /command success alone proves neither every criterion/i);
  const file = path.join(item.root, 'singularity/work-items/EVIDENCE-1/context/prompts/specification-gen1.md');
  const before = await readFile(file, 'utf8');
  const recordFile = file.replace('/prompts/', '/').replace(/\.md$/u, '.json');
  const recordBefore = await readFile(recordFile);
  await composePhasePrompt(item.root, { workId: 'EVIDENCE-1', phase: 'specification', agent: 'product-owner' });
  assert.equal(await readFile(file, 'utf8'), before);
  // An unavailable/foreign newly listed packet is not authority. Deliver the new diagnostic
  // without mutating an already retained generation or silently serving its obsolete projection.
  item.workflow.lineage.submissions.push({ ...item.workflow.lineage.submissions[0], phase: 'specification',
    generation: item.workflow.phases.specification.generation });
  await writeFile(path.join(item.root, 'singularity/work-items/EVIDENCE-1/workflow.json'), JSON.stringify(item.workflow));
  const refreshed = await composePhasePrompt(item.root, { workId: 'EVIDENCE-1', phase: 'specification', agent: 'product-owner' });
  assert.match(refreshed, /Current execution-evidence refresh/);
  assert.match(refreshed, /STORY_REVIEW_EVIDENCE_INVALID/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readFile(recordFile), recordBefore, 'immutable receipt is preserved during a delivered refresh');
});
