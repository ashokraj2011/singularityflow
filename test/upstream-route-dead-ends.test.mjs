import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { setAgentSession } from '../src/session.mjs';
import { snapshot } from '../src/util.mjs';
import { inspectPhaseRecovery } from '../src/recovery-plan.mjs';
import {
  classifyStoryGateFailures, gateRecoveryReopenPlan, pendingOpenStory, verifyGateRecoveryReopenPlan
} from '../src/gate-recovery.mjs';
import { crossPhaseChange } from '../src/evidence/cross-phase-change.mjs';
import { consumeRepairAttempt } from '../src/repair-budget.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { rememberRefusal } from '../src/evidence/refusal-memory.mjs';
import { gateRefusal } from '../src/evidence/gate-refusal.mjs';
import { extractClauses, normalizeClaimMap } from '../src/specifications.mjs';
import { raiseUpstreamIssueRoute, upstreamChangeRoutes } from '../src/upstream-routes.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function story(phaseOrder, { current = phaseOrder.at(-1), currentStatus = 'in_progress', closed = false,
  rejectTo = phaseOrder, reopenCompleted = true, code = [] } = {}) {
  const phases = Object.fromEntries(phaseOrder.map((id) => [id, {
    id, generation: 1,
    status: closed || phaseOrder.indexOf(id) < phaseOrder.indexOf(current) ? 'approved'
      : id === current ? currentStatus : 'not_started',
    generationPolicy: { task: code.includes(id) ? 'code' : 'analyze' },
    requiredArtifact: { kind: 'custom:notes' },
    approvalPolicy: { rejectTo, changeRequests: { reopenCompleted } }
  }]));
  return {
    workItem: { id: 'DEAD-1' }, phaseOrder, phases,
    currentPhase: closed ? null : current, status: closed ? 'closed' : 'in_progress',
    resolution: { obligationGraph: { nodes: [{ id: phaseOrder[0], responsibilities: ['scope'] }] } }
  };
}
const coded = (code, message, extra = {}) => ({ code, message, phase: null, path: null, ...extra });
const ORDER = ['specification', 'implementation', 'conformance'];

test('recover on an approved phase explains how it changes and offers only the routes legal now', async () => {
  const submitted = story(ORDER, { currentStatus: 'awaiting_approval' });
  const result = await inspectPhaseRecovery(packageRoot, {}, submitted, submitted.phases.implementation);
  assert.equal(result.blockers.length, 0);
  assert.match(result.actions[0].detail, /implementation is approved\. An approved phase is never edited or repaired in place/);
  assert.equal(result.actions[0].command, 'singularity-flow recover DEAD-1 --phase conformance --json');
  assert.deepEqual(result.actions.slice(1).map(action => action.command), [
    'singularity-flow reject conformance --work-id DEAD-1 --to implementation --reason <reason>'
  ]);

  const scope = await inspectPhaseRecovery(packageRoot, {}, submitted, submitted.phases.specification);
  assert.deepEqual(scope.actions.slice(1).map(action => action.id), ['return:specification', 'intent-amendment:specification']);

  const authoring = story(ORDER, { currentStatus: 'in_progress', rejectTo: ['conformance'] });
  const blocked = await inspectPhaseRecovery(packageRoot, {}, authoring, authoring.phases.implementation);
  assert.equal(blocked.actions.length, 1, 'no reject is offered from an in-progress phase or to a disallowed target');
  assert.match(blocked.actions[0].detail, /conformance may not return work to implementation; its allowed return targets are conformance/);
  assert.equal(raiseUpstreamIssueRoute(authoring, 'implementation', 'conformance'), null,
    'the raise-upstream-issue hook exists and offers nothing until that route lands');
  assert.deepEqual(upstreamChangeRoutes(authoring, 'conformance').routes, [], 'a phase is not upstream of itself');
});

test('the final gate on an open Story never offers reopen, only routes legal from the final phase status', () => {
  const findings = [
    coded('gate.acceptance-criteria.unbound', 'AC coverage: AC-001 has no module test-source binding'),
    coded('gate.conformance.stale', 'conformance report is stale')
  ];
  const approving = story(ORDER, { code: ['implementation'], currentStatus: 'awaiting_approval' });
  approving.phases.conformance.requiredArtifact.kind = 'conformance-report';
  const [owned, own] = classifyStoryGateFailures(approving, findings, { openStory: { phase: 'conformance', status: 'awaiting_approval' } });
  assert.equal(owned.recovery.ownerPhase, 'implementation');
  assert.equal(owned.recovery.command, 'singularity-flow reject conformance --work-id DEAD-1 --to implementation --reason "Final gate: gate.acceptance-criteria.unbound"');
  assert.equal(own.recovery.command, 'singularity-flow reject conformance --work-id DEAD-1 --to conformance --reason "Final gate: gate.conformance.stale"');

  const submitting = classifyStoryGateFailures(approving, findings, { openStory: { phase: 'conformance', status: 'in_progress' } });
  assert.equal(submitting[0].recovery.mode, 'manual');
  assert.equal(submitting[0].recovery.command, null);
  assert.match(submitting[0].recovery.detail, /must be returned to implementation once it is submitted/);
  assert.equal(submitting[1].recovery.command, 'singularity-flow recover DEAD-1 --phase conformance');

  const narrow = story(ORDER, { code: ['implementation'], currentStatus: 'awaiting_approval', rejectTo: ['conformance'] });
  const [disallowed] = classifyStoryGateFailures(narrow, findings.slice(0, 1), { openStory: { phase: 'conformance', status: 'awaiting_approval' } });
  assert.equal(disallowed.recovery.command, null);
  assert.match(disallowed.recovery.detail, /may not return work to it/);
  for (const finding of [owned, own, ...submitting, disallowed]) {
    assert.doesNotMatch(String(finding.recovery.command), /reopen/);
  }
  assert.deepEqual(pendingOpenStory(approving), { phase: 'conformance', status: 'awaiting_approval' });
  approving.phases.conformance.approvalPolicy.mode = 'policy';
  assert.deepEqual(pendingOpenStory(approving), { phase: 'conformance', status: 'in_progress' });
});

test('a closed Story whose policy forbids reopening offers no reopen route, and gate recovery cannot be confirmed', async () => {
  const closed = story(ORDER, { closed: true, code: ['implementation'], reopenCompleted: false });
  const [finding] = classifyStoryGateFailures(closed, [coded('gate.acceptance-criteria.unbound', 'AC coverage gap')]);
  assert.equal(finding.recovery.requiresReopen, false);
  assert.equal(finding.recovery.command, null);
  assert.match(finding.recovery.detail, /does not allow completed work to be reopened/);
  const plan = gateRecoveryReopenPlan(packageRoot, closed, [{ ...finding, recovery: { ...finding.recovery, requiresReopen: true } }], 'implementation');
  assert.equal(plan.allowed, false);
  assert.equal(plan.blockedBy, 'reopen-disallowed');
  assert.equal(verifyGateRecoveryReopenPlan(packageRoot, closed, { ...plan, allowed: true }), false);

  const open = story(ORDER, { code: ['implementation'] });
  assert.equal(gateRecoveryReopenPlan(packageRoot, open, [], 'implementation').blockedBy, 'story-open');
  const change = await crossPhaseChange(packageRoot, {}, closed, closed.phases.conformance, ['src/app.js'], { records: { planned: [] } });
  assert.ok(change.returns.every(entry => entry.permitted === false), JSON.stringify(change.returns));
  assert.match(change.returns[0].reason, /does not allow completed work to be reopened/);
});

test('an exhausted repair budget names a reachable reset from the submitted phase, not recovery of an approved phase', () => {
  const workflow = story(['intake', 'implementation', 'testing'], { currentStatus: 'awaiting_approval',
    rejectTo: ['intake', 'implementation', 'testing'] });
  workflow.repairBudgets = {};
  const budget = { id: 'implementation', repairBudget: { maxAttempts: 1, resetOnPhase: 'intake' } };
  const source = workflow.phases.testing;
  consumeRepairAttempt(workflow, budget, { targetPhase: 'implementation', sourcePhase: source, actor: {}, at: 't1', changeRequestId: 'CR-1' });
  let error;
  try {
    consumeRepairAttempt(workflow, budget, { targetPhase: 'implementation', sourcePhase: source, actor: {}, at: 't2', changeRequestId: 'CR-2' });
  } catch (caught) { error = caught; }
  assert.equal(error?.code, 'REPAIR_BUDGET_EXHAUSTED');
  assert.equal(error.details.currentPhase, 'testing');
  assert.equal(error.details.resetCommand, 'singularity-flow reject testing --work-id DEAD-1 --to intake --reason <reason>');
  assert.match(error.message, /Return the submission to 'intake' instead/);
  const plan = refusalRemediationPlan(error, ['reject', 'testing', '--to', 'implementation', '--reason', 'again']);
  assert.equal(plan.context.phaseId, 'testing');
  assert.equal(plan.steps[0].command, error.details.resetCommand);
  assert.match(plan.steps[1].label, /ask the approvers for direction/i);
  assert.doesNotMatch(JSON.stringify(plan), /--phase implementation/);

  workflow.phases.testing.approvalPolicy.rejectTo = ['implementation', 'testing'];
  const noReset = (() => {
    try { consumeRepairAttempt(workflow, budget, { targetPhase: 'implementation', sourcePhase: source, actor: {}, at: 't3', changeRequestId: 'CR-3' }); }
    catch (caught) { return caught; }
    return null;
  })();
  assert.equal(noReset.details.resetCommand, null);
  const human = refusalRemediationPlan(noReset, ['reject', 'testing', '--to', 'implementation']);
  assert.match(human.steps[0].label, /No allowed return resets the implementation repair budget/);
});

test('recover surfaces a remembered refused ending instead of reporting no blockers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refused-ending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Ending Tester');
  git(root, 'config', 'user.email', 'ending@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ending fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const source = YAML.parse(await readFile(file, 'utf8'));
  source.workItemRoot = 'team/stories';
  source.session.workItemSelection = 'reuse';
  await writeFile(file, YAML.stringify(source));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture authority');
  git(root, 'switch', '-c', 'ENDING-1');
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, {
    id: 'ENDING-1', title: 'Surface refused endings', baseBranch: 'main',
    workType: 'spec-driven-standard', agent: 'product-owner', resolved: resolveWorkType(config, 'spec-driven-standard'),
    source: { type: 'manual', key: 'ENDING-1', title: 'Surface refused endings', description: 'Never "Blockers: none".',
      acceptanceCriteria: ['A refused ending is visible to recovery.'] }
  });
  await setAgentSession(root, config, { name: 'Ending Tester', email: 'ending@example.invalid' },
    workflow.phases[workflow.currentPhase].defaultAgent, 'ENDING-1', { phaseId: workflow.currentPhase, source: 'test' });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accepted Story');
  const phase = workflow.currentPhase;
  await rememberRefusal(root, 'ENDING-1', 'sha256:fingerprint', gateRefusal({
    code: 'STORY_TERMINAL_READINESS_REFUSED', gate: 'terminal', subject: { workId: 'ENDING-1', phase, generation: 1 },
    findings: [{ code: 'gate.specification-index.scope-unresolved', message: 'A scope item is unresolved.' }],
    actions: ['singularity-flow reopen ENDING-1 --to specification --reason "Governance recovery"',
      'singularity-flow evidence matrix ENDING-1 --json']
  }), '2026-10-12T00:00:00.000Z');
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, '.git/mode-not-set.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/no-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/no-registry.json') };
  const result = spawnSync(process.execPath, [cli, 'recover', 'ENDING-1', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout);
  const blocker = plan.blockers.find(entry => entry.category === 'terminal-readiness');
  assert.ok(blocker, JSON.stringify(plan.blockers));
  assert.equal(blocker.code, 'refusal.story-terminal-readiness-refused');
  assert.match(blocker.details.message, /A scope item is unresolved/);
  const commands = plan.actions.map(action => action.command);
  assert.ok(commands.includes('singularity-flow evidence matrix ENDING-1 --json'), JSON.stringify(commands));
  assert.ok(!commands.some(command => /reopen/.test(command ?? '')), 'an open Story is never offered reopen');
});

test('cross-phase specification and Story-state refusals are coded and routed', () => {
  assert.throws(() => extractClauses('[APP:AC-001]\nDepends on APP:REQ-999.'), {
    code: 'SPEC_CLAUSE_DEPENDENCY_MISSING', details: { clause: 'APP:AC-001', dependency: 'APP:REQ-999', line: 1 }
  });
  assert.throws(() => extractClauses('[APP:REQ-001]\nAPP:REQ-002\n\n[APP:REQ-002]\nAPP:REQ-001'), { code: 'SPEC_CLAUSE_DEPENDENCY_CYCLE' });
  assert.throws(() => normalizeClaimMap({ 'APP:REQ-404': { expectedPaths: ['src/a.js'] } }, {
    kind: 'planned', clauseIds: ['APP:REQ-001']
  }), { code: 'SPEC_CLAIM_MAP_UNKNOWN_CLAUSE', details: { kind: 'planned', clause: 'APP:REQ-404' } });
  const unknown = refusalRemediationPlan(Object.assign(new Error('unknown clause'), { code: 'SPEC_CLAIM_MAP_UNKNOWN_CLAUSE',
    details: { clause: 'APP:REQ-404' } }), ['phase', 'publish', 'planning']);
  assert.equal(unknown.steps.find(step => step.id === 'list-defined-clauses').command, 'singularity-flow spec trace --format json');

  const invalid = Object.assign(new Error('Story state is invalid before publication'), { code: 'STORY_STATE_INVALID',
    details: { problems: ['planning artifact hash mismatch'] } });
  assert.equal(refusalRemediationPlan(invalid, ['submit', 'planning']).steps.some(step => step.command === 'singularity-flow validate'), true);
  assert.equal(refusalRemediationPlan(invalid, ['validate']).steps.some(step => step.command === 'singularity-flow validate'), false,
    'validate is never told to run itself again');
  const documentDrift = refusalRemediationPlan(Object.assign(new Error('Document drift'), { code: 'DOCUMENT_HASH_MISMATCH',
    details: { documentId: 'DOC-001' } }), ['wm', 'compose', '--phase', 'planning']);
  assert.ok(documentDrift.steps.some(step => step.command === 'singularity-flow documents list --json'));
  const epic = refusalRemediationPlan(Object.assign(new Error('Cannot publish epic-requirements'), { code: 'EPIC_TRACEABILITY_INCOMPLETE',
    details: { subjectKind: 'initiative', phase: 'epic-requirements', problems: ['REQ-1 has no Story'] } }),
  ['initiative', 'phase', 'publish', 'epic-requirements']);
  assert.equal(epic.steps[0].command, 'singularity-flow initiative phase draft-check epic-requirements --json');
});
