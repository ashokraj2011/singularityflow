import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { setAgentSession } from '../src/session.mjs';
import { snapshot } from '../src/util.mjs';
import { inputReadinessFindings, phaseInputsNotReadyError } from '../src/inputs.mjs';
import { refusalEnvelope, refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { phaseContextAdmission, phaseAdmissionActions } from '../src/phase-entry-admission.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { completeAgentResult, withAgentRoutes } from '../src/agent-output.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
const SPEC = 'team/stories/ROUTE-1/artifacts/specification/spec.md';
const APPROVED = '# Approved specification\n\n[ROUTE-1:REQ-001] Preserve exact input identity.\n';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A Story at planning whose approved specification is an enforced input. */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-input-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Route Tester');
  git(root, 'config', 'user.email', 'route@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Route fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const source = YAML.parse(await readFile(file, 'utf8'));
  source.workItemRoot = 'team/stories';
  source.session.workItemSelection = 'reuse';
  source.workTypes['spec-driven-standard'].phaseOverrides.planning.inputs = [
    { phase: 'specification', projection: 'full' }
  ];
  await writeFile(file, YAML.stringify(source));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture authority');
  git(root, 'switch', '-c', 'ROUTE-1');
  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'spec-driven-standard');
  const workflow = await createWorkflow(root, config, {
    id: 'ROUTE-1', title: 'Route upstream input defects', baseBranch: 'main',
    workType: 'spec-driven-standard', agent: 'product-owner', resolved,
    source: { type: 'manual', key: 'ROUTE-1', title: 'Route upstream input defects',
      description: 'A later phase never repairs an earlier phase in place.',
      acceptanceCriteria: ['An upstream input defect returns a coded, executable route.'] }
  });
  // Internal fixture state, not an approval operation: the Story starts at an approved input boundary.
  await writeFile(path.join(root, SPEC), APPROVED);
  Object.assign(workflow.phases.specification, { status: 'approved', generation: 1,
    artifacts: [{ path: SPEC, status: 'approved', ...await snapshot(path.join(root, SPEC)) }] });
  workflow.currentPhase = 'planning';
  workflow.phases.planning.status = 'in_progress';
  await writeFile(path.join(root, 'team/stories/ROUTE-1/workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
  await setAgentSession(root, config, { name: 'Route Tester', email: 'route@example.invalid' },
    workflow.phases.planning.defaultAgent, 'ROUTE-1', { phaseId: 'planning', source: 'test' });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accepted Story at planning');
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, '.git/mode-not-set.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/no-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/no-registry.json') };
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000
  });
  return { root, workflow, config, invoke };
}

const drifted = { mode: 'enforce', errors: ['planning input from specification no longer matches its approved hash'],
  records: [{ phase: 'specification', repositoryPath: SPEC, status: 'hash_mismatch', producerStatus: 'approved',
    approvedSha256: 'a'.repeat(64), sha256: 'b'.repeat(64), optional: false }] };

function routedWorkflow(planningStatus = 'in_progress') {
  return {
    workItem: { id: 'ROUTE-1' }, currentPhase: 'planning', phaseOrder: ['specification', 'planning', 'implementation'],
    resolution: { obligationGraph: { nodes: [{ id: 'specification', responsibilities: ['scope'] },
      { id: 'planning', responsibilities: ['plan'] }] } },
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, approvalPolicy: { rejectTo: ['specification'] } },
      planning: { id: 'planning', status: planningStatus, generation: planningStatus === 'awaiting_approval' ? 1 : 0,
        approvalPolicy: { rejectTo: ['specification', 'planning'] } },
      implementation: { id: 'implementation', status: 'not_started', generation: 0 }
    }
  };
}

test('PHASE_INPUTS_NOT_READY names the consumer, every producer finding and the legal routes', () => {
  const awaiting = routedWorkflow('awaiting_approval');
  const error = phaseInputsNotReadyError(awaiting, awaiting.phases.planning, drifted);
  assert.equal(error.code, 'PHASE_INPUTS_NOT_READY');
  assert.match(error.message, /Phase planning inputs are not ready/);
  assert.match(error.message, /belong to specification; planning must not edit them/);
  assert.equal(error.details.phase, 'planning');
  assert.equal(error.details.currentPhase, 'planning');
  assert.deepEqual(error.details.upstreamPhases, ['specification']);
  assert.deepEqual(error.details.findings.map(({ phase, path: file, status, restorable }) => ({ phase, path: file, status, restorable })),
    [{ phase: 'specification', path: SPEC, status: 'hash_mismatch', restorable: true }]);
  // Submitted planning may return to specification; the scope step can also be amended.
  assert.deepEqual(error.details.routes.map(route => route.kind), ['return', 'intent-amendment', 'upstream-issue']);
  assert.match(error.details.routes[0].command, /^singularity-flow reject planning --work-id ROUTE-1 --to specification/);

  const inProgress = routedWorkflow('in_progress');
  const early = phaseInputsNotReadyError(inProgress, inProgress.phases.planning, drifted);
  assert.deepEqual(early.details.routes.map(route => route.kind), ['intent-amendment', 'upstream-issue'],
    'reject is illegal from an in-progress phase, so it is never offered as a command; raising stays open');
  assert.match(early.details.notes[0], /Once planning is submitted/);

  const unapproved = inputReadinessFindings({ ...drifted, records: [{ ...drifted.records[0], status: 'unapproved',
    producerStatus: 'in_progress' }] });
  assert.equal(unapproved[0].restorable, false, 'an unapproved producer has no approved bytes to restore');
});

test('upstream-input remediation inspects, restores, then returns; never repairs the producer in place', () => {
  const awaiting = routedWorkflow('awaiting_approval');
  const error = phaseInputsNotReadyError(awaiting, awaiting.phases.planning, drifted);
  for (const argv of [['inputs', 'planning'], ['phase', 'enter', 'planning', '--compose'], ['wm', 'compose', '--phase', 'planning']]) {
    const plan = refusalRemediationPlan(error, argv);
    assert.deepEqual(plan.steps.map(entry => entry.command), [
      'singularity-flow inputs planning --dry-run --json',
      'singularity-flow inputs restore planning',
      'singularity-flow reject planning --work-id ROUTE-1 --to specification --reason <reason>'
    ], argv.join(' '));
    assert.equal(plan.context.phaseId, 'planning');
    assert.equal(plan.context.strategy, 'upstream-input');
    assert.deepEqual(plan.context.upstreamPhases, ['specification']);
    assert.ok(plan.steps.every(entry => /come[s]? from specification/.test(entry.label) && /must not (?:be edited by planning|edit it)/.test(entry.label)),
      JSON.stringify(plan.steps.map(entry => entry.label)));
    assert.doesNotMatch(JSON.stringify(plan), /--phase specification|repair-current-phase|doctor/);
    assert.match(renderRefusalPlan(plan), /approved input from specification; do not edit it here/);
  }
  // Nothing to restore and no return from an in-progress step: raising the issue is offered.
  const inProgress = routedWorkflow('in_progress');
  const unapprovedInputs = { ...drifted, records: [{ ...drifted.records[0], status: 'unapproved', producerStatus: 'in_progress' }] };
  const early = refusalRemediationPlan(phaseInputsNotReadyError(inProgress, inProgress.phases.planning, unapprovedInputs), ['inputs', 'planning']);
  assert.equal(early.steps.at(-1).id, 'raise-upstream-issue');
  assert.match(early.steps.at(-1).command, /^singularity-flow upstream-issue raise --work-id ROUTE-1 --phase specification /);
  const envelope = refusalEnvelope(error, ['inputs', 'planning']);
  assert.deepEqual(envelope.error.details.upstreamPhases, ['specification']);
  assert.equal(envelope.error.details.currentPhase, 'planning');
  assert.equal(envelope.error.details.findings[0].status, 'hash_mismatch');
  assert.equal(envelope.error.details.findings[0].path, SPEC);
});

test('producer-owned index and convergence refusals keep the consuming phase as the containment scope', () => {
  const index = Object.assign(new Error('Active Clause Capsule refused unverified specification context'), {
    code: 'SPECIFICATION_INDEX_UNTRUSTED',
    details: { phase: 'specification', producerPhase: 'specification', upstreamPhases: ['specification'],
      currentPhase: 'planning', problems: ['source artifact does not match its approved hash'], restorable: true }
  });
  const plan = refusalRemediationPlan(index, ['wm', 'compose', '--phase', 'planning']);
  assert.equal(plan.context.phaseId, 'planning');
  assert.deepEqual(plan.steps.map(entry => entry.command).slice(0, 2),
    ['singularity-flow inputs planning --dry-run --json', 'singularity-flow inputs restore planning']);
  assert.doesNotMatch(JSON.stringify(plan), /recover ROUTE-1 --phase specification|--phase specification/);
  // An older throw site named only the producer in `phase`; the command's own phase still wins.
  const legacy = refusalRemediationPlan(Object.assign(new Error('stale'), {
    code: 'CONVERGENCE_UPSTREAM_ARTIFACT_STALE', details: { phase: 'specification', path: SPEC }
  }), ['phase', 'enter', 'convergence']);
  assert.equal(legacy.context.phaseId, 'convergence');
  assert.equal(legacy.steps[0].command, 'singularity-flow inputs convergence --dry-run --json');
  assert.match(legacy.steps[0].label, /come from specification and must not be edited by convergence/);
  const committed = refusalRemediationPlan(Object.assign(new Error('stale'), {
    code: 'CONVERGENCE_UPSTREAM_ARTIFACT_STALE', details: { phase: 'specification', currentPhase: 'convergence', restorable: false }
  }), ['phase', 'enter', 'convergence']);
  assert.ok(!committed.steps.some(entry => entry.command?.includes('inputs restore')), 'restore is not offered when it cannot work');
});

test('remediation reads a throw site\'s own repair command, and phase enter keeps phase recovery', () => {
  const repair = refusalRemediationPlan(Object.assign(new Error('Future phase validator refused.'), {
    code: 'FUTURE_PHASE_VALIDATOR', details: { workId: 'ROUTE-1', repairCommand: 'singularity-flow appeal list --phase planning --json' }
  }), ['phase', 'publish', 'planning']);
  assert.equal(repair.steps[0].command, 'singularity-flow appeal list --phase planning --json');
  const command = refusalRemediationPlan(Object.assign(new Error('Future phase validator refused.'), {
    code: 'FUTURE_PHASE_VALIDATOR', details: { workId: 'ROUTE-1', command: 'singularity-flow story test-policy risks --json' }
  }), ['phase', 'publish', 'planning']);
  assert.equal(command.steps[0].command, 'singularity-flow story test-policy risks --json');
  const enter = refusalRemediationPlan(Object.assign(new Error('Future entry check refused.'), {
    code: 'FUTURE_ENTRY_CHECK', details: { workId: 'ROUTE-1' }
  }), ['phase', 'enter', 'planning', '--compose', '--for-agent', '--json']);
  assert.equal(enter.steps[0].command, 'singularity-flow recover ROUTE-1 --phase planning --json');
  assert.doesNotMatch(JSON.stringify(enter), /phase --help|doctor/);
});

test('input blockers refuse context admission with a plan, and lead the next actions', () => {
  const recovery = { requiresRecovery: false, blockers: [{
    code: 'phase.inputs.not-ready', category: 'inputs', path: SPEC,
    details: { sourceCode: 'PHASE_INPUTS_NOT_READY', upstreamPhase: 'specification', status: 'hash_mismatch', restorable: true }
  }], actions: [
    { id: 'prepare-artifact:planning', command: 'singularity-flow prepare planning' },
    { id: 'resolve-inputs:planning', command: 'singularity-flow inputs planning --dry-run --json' },
    { id: 'restore-inputs:planning', command: 'singularity-flow inputs restore planning' }
  ] };
  const authoring = { entry: { status: 'authoring-entry' }, policyVerified: true, effectiveAuthoringSkill: '/sf-phase' };
  const admission = phaseContextAdmission({ authoring, recovery, references: {} });
  assert.equal(admission.allowed, false);
  const blocker = admission.blockers.find(entry => entry.code === 'PHASE_CONTEXT_INPUTS_NOT_READY');
  assert.ok(blocker, JSON.stringify(admission.blockers));
  assert.deepEqual(blocker.upstreamPhases, ['specification']);
  assert.deepEqual(blocker.findings, [{ phase: 'specification', path: SPEC, status: 'hash_mismatch', restorable: true }]);
  assert.match(blocker.message, /must not be edited here/);
  assert.deepEqual(phaseAdmissionActions(recovery.actions, admission, { authoring, recovery }).map(action => action.id),
    ['resolve-inputs:planning', 'restore-inputs:planning', 'prepare-artifact:planning']);
});

test('an input finding resolves to the producer\'s restore and return routes, not doctor', () => {
  const workflow = routedWorkflow('awaiting_approval');
  const finding = { code: 'phase.inputs.not-ready', category: 'inputs', path: SPEC,
    details: { sourceCode: 'PHASE_INPUTS_NOT_READY', upstreamPhase: 'specification', status: 'hash_mismatch', restorable: true } };
  const result = phaseResolutionChoices(workflow, workflow.phases.planning, finding);
  assert.equal(result.choices[0].kind, 'restore-upstream-input');
  assert.equal(result.choices[0].owner, 'specification');
  assert.equal(result.choices[0].command, 'singularity-flow inputs restore planning');
  assert.match(result.choices[0].detail, /comes from specification and must not be edited by planning/);
  assert.equal(result.choices[1].kind, 'upstream-return');
  assert.match(result.choices[1].command, /reject planning --work-id ROUTE-1 --to specification/);
  assert.ok(!result.choices.some(choice => choice.command === 'singularity-flow doctor --json'));
  const unrestorable = phaseResolutionChoices(routedWorkflow('in_progress'), routedWorkflow('in_progress').phases.planning,
    { ...finding, details: { ...finding.details, status: 'unapproved', restorable: false } });
  assert.equal(unrestorable.choices[0].command, 'singularity-flow inputs planning --dry-run --json');
  assert.match(unrestorable.choices[0].detail, /comes from specification and must not be edited by planning.*amendment/);
});

test('a drifted approved input is reported by the dry run, coded at preparation, and refused at entry with a plan', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, SPEC), `${APPROVED}\nAn unreviewed edit.\n`);
  const before = await readFile(path.join(item.root, 'team/stories/ROUTE-1/workflow.json'), 'utf8');

  const dryRun = item.invoke('inputs', 'planning', '--dry-run', '--json');
  assert.equal(dryRun.status, 0, 'a dry run reports instead of throwing\n' + dryRun.stderr + dryRun.stdout);
  const report = completeAgentResult(dryRun.stdout);
  assert.equal(report.records[0].status, 'hash_mismatch');
  assert.equal(report.readiness.ready, false);
  assert.deepEqual(report.readiness.upstreamPhases, ['specification']);
  assert.equal(report.readiness.findings[0].restorable, true);
  assert.equal(report.readiness.restoreCommand, 'singularity-flow inputs restore planning');
  const human = item.invoke('inputs', 'planning', '--dry-run');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /belong to specification; planning must not edit them/);

  const prepared = item.invoke('inputs', 'planning', '--json');
  assert.notEqual(prepared.status, 0);
  const refusal = completeAgentResult(prepared.stdout);
  assert.equal(refusal.error.code, 'PHASE_INPUTS_NOT_READY');
  assert.deepEqual(refusal.error.details.upstreamPhases, ['specification']);
  assert.equal(refusal.remediationPlan.context.strategy, 'upstream-input');
  assert.equal(refusal.remediationPlan.steps[0].command, 'singularity-flow inputs planning --dry-run --json');
  assert.equal(refusal.remediationPlan.steps[1].command, 'singularity-flow inputs restore planning');

  const entry = item.invoke('phase', 'enter', 'planning', '--compose', '--for-agent', '--json');
  assert.equal(entry.status, 0, entry.stderr || entry.stdout);
  const packet = completeAgentResult(entry.stdout);
  assert.equal(packet.contextComposition, 'not-admitted');
  assert.equal(packet.context, null);
  assert.ok(packet.contextAdmission.blockers.some(blocker => blocker.code === 'PHASE_CONTEXT_INPUTS_NOT_READY'),
    JSON.stringify(packet.contextAdmission));
  assert.equal(packet.next[0].command, 'singularity-flow inputs planning --dry-run --for-agent --json', 'the agent runs the dry run bounded');

  const composed = item.invoke('wm', 'compose', '--phase', 'planning', '--work-id', 'ROUTE-1', '--json');
  assert.notEqual(composed.status, 0);
  assert.equal(completeAgentResult(composed.stdout).error.code, 'PHASE_INPUTS_NOT_READY');
  assert.equal(await readFile(path.join(item.root, 'team/stories/ROUTE-1/workflow.json'), 'utf8'), before);
});

test('a pending prompt is recomposed when an approved input changed, and refused when one is no longer ready', async t => {
  const item = await fixture(t);
  const first = item.invoke('phase', 'enter', 'planning', '--compose', '--for-agent', '--json');
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const entry = completeAgentResult(first.stdout);
  assert.equal(entry.contextComposition, 'delivered', JSON.stringify(entry.contextAdmission));
  assert.match(entry.context.text, /Preserve exact input identity/);
  const context = path.join(item.root, 'team/stories/ROUTE-1/context');
  const record = JSON.parse(await readFile(path.join(context, 'planning-gen1.json'), 'utf8'));
  assert.deepEqual(record.promptBudget.inputDigests.map(({ phase, path: file, status }) => ({ phase, path: file, status })),
    [{ phase: 'specification', path: SPEC, status: 'captured' }]);

  // An unreviewed edit: the reused prompt would carry stale evidence, so composition refuses.
  await writeFile(path.join(item.root, SPEC), `${APPROVED}\nAn unreviewed edit.\n`);
  const refused = item.invoke('wm', 'compose', '--phase', 'planning', '--work-id', 'ROUTE-1', '--json');
  assert.notEqual(refused.status, 0);
  assert.equal(completeAgentResult(refused.stdout).error.code, 'PHASE_INPUTS_NOT_READY');

  // A newly approved specification generation: the pending prompt is set aside and recomposed.
  const amended = `${APPROVED}\n[ROUTE-1:REQ-002] Recompose stale prompts.\n`;
  await writeFile(path.join(item.root, SPEC), amended);
  const workflowFile = path.join(item.root, 'team/stories/ROUTE-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  workflow.phases.specification.generation = 2;
  workflow.phases.specification.artifacts = [{ path: SPEC, status: 'approved', ...await snapshot(path.join(item.root, SPEC)) }];
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  git(item.root, 'add', '.');
  git(item.root, 'commit', '-qm', 'simulated specification generation 2');
  const again = item.invoke('phase', 'enter', 'planning', '--compose', '--for-agent', '--json');
  assert.equal(again.status, 0, again.stderr || again.stdout);
  const recomposed = completeAgentResult(again.stdout);
  assert.equal(recomposed.contextComposition, 'delivered', JSON.stringify(recomposed.contextAdmission));
  assert.match(recomposed.context.text, /Recompose stale prompts/);
  assert.match(again.stderr, /Recomposing planning generation 1: approved input from specification changed/);
  const superseded = path.join(context, 'superseded');
  assert.ok(existsSync(superseded));
  assert.equal((await readdir(superseded)).length, 1);
});
