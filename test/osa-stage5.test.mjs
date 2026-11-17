/**
 * SPEC-OSA v1.1 Stage 5 (plan section 7): what removing the duplicates changed, through the real guard where a write is
 * involved, with expected results written out from the specification:
 *   - the edit guard reads the step's task stage: a spent repair budget stops its writes through the kernel, as it stops
 *     every view, and a stage recorded during a turn derives that turn's grant again [§8, OSA:REQ-010, REQ-012];
 *   - a published step whose execution still runs is observed by every view, never submitted meanwhile [§5, §8, REQ-051];
 *   - every route the renderer gives is one of the action-to-command map's named forms [§10, REQ-021, AC-003];
 *   - the refusals that named recovery for healthy work name their continuation [D4, REQ-011, REQ-022];
 *   - activation and reversal (docs/osa/activation.md): no new record, read-only surfaces change no Story byte, and a fenced
 *     writer stays out when the machine's turn records are lost, as a reinstall or a reversal loses them [§14, REQ-034].
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { OPERATIONS, RECORD_ADMISSION, stepState } from '../src/kernel/step-state.mjs';
import { ACTION_COMMANDS, actionCommand, decisionRoutes, stepDecisionOf, stepSnapshotOf } from '../src/step-decision.mjs';
import { deriveMutationContract, mutationPathDecision } from '../src/phase-mutation-contract.mjs';
import { outcomeCode, readGuardTaskOutcome, readTaskOutcome, taskOutcomeOf } from '../src/workflow-task-outcome.mjs';
import { observeWorkflowTask, readWorkflowTaskResume } from '../src/workflow-task-store.mjs';
import { observeOpening } from '../src/story-version-acceptance.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { approveRoute, authorCommand, authorRoute, handoffSubmitRoute, returnRoute, showCommand, storyNextCommand, versionPreviewCommand,
  versionQuestionRoute } from '../src/action-command-map.mjs';
import { requestedSuccessorAction } from '../src/guide.mjs';
import { noSpecificationClausesError } from '../src/state.mjs';
import { findingEscalation, ESCALATION_THRESHOLD } from '../src/finding-escalation.mjs';
import { upstreamChangeRoutes } from '../src/upstream-routes.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { LIFECYCLE_EVENT_TYPES } from '../src/lifecycle-event.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { acceptOpening } from './helpers/accepted-opening.mjs';

const W = 'OSA-S5';

/**
 * A Story at its code step `implement` after an approved `design`: version 2 open through the opening operation and held
 * here (`open`), or version 1 published with nothing open. A real Git checkout, as the guard reads it.
 */
async function story(t, { open = true } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-osa-s5-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  git('init', '-q'); git('config', 'user.name', 'Stage Five'); git('config', 'user.email', 'stage5@example.test');
  await writeFile(path.join(root, 'src', 'App.java'), 'final class App {}\n');
  const implement = { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
    generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/implement/summary.md', kind: 'implementation-summary' }, repairBudget: { maxAttempts: 2 },
    generationIntent: open ? { id: 'GI-2', status: 'open', generation: 2 } : { id: 'GI-1', status: 'consumed', generation: 1 },
    generationPublications: [{ generation: 1, record: { path: `singularity/work-items/${W}/publications/implement-1.json`, sha256: `sha256:${'c'.repeat(64)}` } }] };
  const workflow = { schemaVersion: 13, workItem: { id: W }, status: 'in_progress', currentPhase: 'implement',
    phaseOrder: ['design', 'implement', 'verify'], history: [{ at: '2026-11-17T08:00:00.000Z', event: 'phase_approved', phase: 'design' }],
    phases: { design: { id: 'design', status: 'approved', generation: 1, writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' } },
      implement, verify: { id: 'verify', status: 'pending', generation: 0, writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' } } },
    resolution: {} };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  if (open) await acceptOpening(root, workflow, implement);
  const workflowFile = path.join(root, 'singularity', 'work-items', W, 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', 'fixture');
  const accepted = { definition, workflow };
  let sessions = 0;
  const enter = async (skill, { sessionId = `osa-s5-${sessions += 1}` } = {}) => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now: Date.now(), captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  const write = (turn, target) => mutationToolGuard({ ...turn, toolName: 'edit', toolArgs: { path: target } });
  const save = () => writeFile(workflowFile, JSON.stringify(workflow));
  return { root, directory, workflow, definition, implement, enter, write, save, git };
}

/** What every view names as the step's next action, at one basis [OSA:REQ-020]. */
const views = (workflow, taskOutcome) => {
  const phase = workflow.phases[workflow.currentPhase];
  return {
    kernel: decisionRoutes(stepDecisionOf(workflow, phase, { task: taskOutcome }), workflow, phase)[0].command,
    next: workflowNextSteps(workflow, { taskOutcome, pendingDecisions: null }).find((entry) => entry.timing === 'now')?.command,
    guide: workflowGuide(workflow, { taskOutcome }).nextActions[0]?.command,
    readiness: submissionReadinessSnapshot(workflow, { taskOutcome }).command
  };
};

// ------------------------------------------------------------------------------------------- the guard reads the task stage

test('the edit guard reads the task stage: a repair within budget keeps the version\'s writes, a spent one stops them through the kernel [§8, OSA:REQ-010, REQ-012]', async (t) => {
  const f = await story(t);
  const repair = (used) => observeWorkflowTask(f.root, f.workflow, f.implement, { state: 'blocked', repairConsumed: used,
    blockedCode: outcomeCode('repair-required', 'CODE_TEST_FAILED', f.workflow) });
  await repair(1);
  // The guard reads what every view reads (no publication left pending here): the task record, from private files only.
  const read = await readGuardTaskOutcome(f.root, f.workflow, f.implement);
  assert.deepEqual([read.task.outcome, read.task.repairs], ['repair-required', { used: 1, budget: 2 }]);
  assert.deepEqual((await readTaskOutcome(f.root, f.workflow, f.implement)).repairs, read.task.repairs);
  assert.equal(read.files.length, 1, 'the guard stamps the task record it stands on');

  // Attempt 2 of 2: the step's own repair, so its version is written in this turn.
  const turn = await f.enter('/sf-code');
  assert.deepEqual(await f.write(turn, 'src/App.java'), {}, 'a repair within the budget writes the open version');

  // The budget is spent while the turn is open: the turn's grant is derived again and the write is refused.
  await repair(2);
  const stopped = await f.write(turn, 'src/App.java');
  assert.equal(stopped.permissionDecision, 'deny', 'a spent repair budget is not kept from before');
  // A new turn of the work command: refused before any byte changes, naming the person's decision on the card [§8].
  const fresh = await f.enter('/sf-code');
  const refused = await f.write(fresh, 'src/App.java');
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, new RegExp(`singularity-flow decisions ${W}`, 'u'));
  assert.doesNotMatch(refused.permissionDecisionReason, /singularity-flow recover\b|\/sf-recover/u, 'a spent budget is no damage');
  assert.equal(await readFile(path.join(f.root, 'src', 'App.java'), 'utf8'), 'final class App {}\n');

  // The entry's permission and the guard's grant stand on the same basis: the same kernel decision with the same task.
  const spent = (await readGuardTaskOutcome(f.root, f.workflow, f.implement)).task;
  const contract = deriveMutationContract({ root: f.root, definition: f.definition, workflow: f.workflow, turnMode: 'authoring',
    opening: observeOpening(f.root, f.workflow, f.implement), task: spent });
  assert.deepEqual([contract.allow.application, contract.allow.artifacts], [false, []]);
  assert.equal(mutationPathDecision(contract, 'src/App.java', f.root).allowed, false);
  assert.equal(contract.next[0].command, `singularity-flow decisions ${W}`);
  const kernel = stepState(stepSnapshotOf({ workflow: f.workflow, turnMode: 'authoring', opening: observeOpening(f.root, f.workflow, f.implement), task: spent }));
  assert.deepEqual([kernel.state, kernel.next.operation, kernel.next.inputs.outcome, kernel.edit.eligible], ['waiting', 'decide', 'repair-exhausted', false]);
  for (const command of Object.values(views(f.workflow, spent))) assert.equal(command, `singularity-flow decisions ${W}`, 'every view names the same card');
});

test('the permission follows the kernel for every task stage it is given; a running execution keeps the version\'s writes [§8, OSA:REQ-010, REQ-051]', () => {
  const workflow = { schemaVersion: 13, workItem: { id: W }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['implement'], history: [],
    // Version 1 open by its own intent (an initial version needs no operation's record, §4.3).
    phases: { implement: { id: 'implement', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
      generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
      generationIntent: { status: 'open', generation: 1 } } }, resolution: {} };
  const grant = (task) => deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow, turnMode: 'authoring', task }).allow;
  assert.equal(grant(null).application, true, 'the open version is written');
  for (const outcome of ['waiting-input', 'waiting-environment', 'waiting-person']) {
    assert.deepEqual(grant({ id: null, outcome, code: 'CODE_TEST_FAILED' }), { artifacts: [], application: false, staging: [] }, outcome);
  }
  assert.equal(grant({ id: null, outcome: 'running', code: 'STORY_LEASE_HELD', stage: 'execution' }).application, true, 'an execution is observed, never a stop');
  assert.equal(grant({ id: null, outcome: 'repair-required', code: 'CODE_TEST_FAILED', repairs: { used: 0, budget: 3 } }).application, true);
});

test('a published step whose execution still runs is observed by every view, never submitted or reviewed meanwhile [§5 waiting, §8, OSA:REQ-051]', async (t) => {
  const f = await story(t, { open: false });
  const running = { id: null, outcome: 'running', code: 'STORY_LEASE_HELD', stage: 'execution', progressReference: '2026-11-17T09:00:00.000Z' };
  const decision = stepDecisionOf(f.workflow, f.implement, { task: running });
  assert.deepEqual([decision.state, decision.next.operation, decision.next.inputs, decision.edit.eligible],
    ['waiting', 'inspect', { task: 'execution' }, false]);
  for (const [view, command] of Object.entries(views(f.workflow, running))) {
    assert.equal(command, 'singularity-flow session current --for-agent --json', `${view} observes the running execution`);
  }
  // Review 2026-11-17 (kernel #11b): that route, `session current`, shows the running execution, read from the Story's live
  // lease, never only the task record (which says nothing of it).
  const resume = await readWorkflowTaskResume(f.root, f.workflow, f.implement, { published: true, execution: running });
  assert.deepEqual([resume?.execution?.status, resume?.execution?.code, resume?.execution?.lastHeartbeatAt], ['running', 'STORY_LEASE_HELD', '2026-11-17T09:00:00.000Z'], JSON.stringify(resume));
  assert.match(resume.execution.words, /still running .*Nothing is started again while it runs/u);
  // No lease held: nothing is said to run.
  assert.equal((await readWorkflowTaskResume(f.root, f.workflow, f.implement, { published: true }))?.execution, undefined);
  // Without it, the same published step is submitted, as before [§5 precedence 10].
  assert.equal(stepDecisionOf(f.workflow, f.implement).next.operation, 'submit-version');
  // Never on a step that has nothing published: its version 1 keeps its own action [§5 precedence 7].
  const fresh = { ...f.workflow, phases: { ...f.workflow.phases, implement: { ...f.implement, generation: 0, generationIntent: null, generationPublications: [] } } };
  assert.notEqual(stepDecisionOf(fresh, fresh.phases.implement, { task: running }).next.operation, 'inspect');
});

// ------------------------------------------------------------------------------------------- the action-to-command map

test('every route the renderer gives is one of the action-to-command map\'s named forms, for every kernel operation [§10, OSA:REQ-021, AC-003]', () => {
  const workflow = { schemaVersion: 13, workItem: { id: W }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['implement', 'intake'], history: [],
    phases: { implement: { id: 'implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
      generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] } },
    intake: { id: 'intake', status: 'pending', generation: 0, writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' } } },
    resolution: {} };
  const inputs = [{}, { consent: 'required', version: 2, from: 1 }, { operation: 'version-opening', version: 2 }, { decision: 'story-decision' },
    { decision: 'task-outcome', outcome: 'repair-exhausted' }, { task: 'execution' }, { source: 'lifecycle' }, { source: 'review' }, { pending: true }];
  let rendered = 0;
  for (const operation of OPERATIONS) for (const phase of ['implement', 'intake']) for (const given of inputs) {
    const decision = { next: { operation, inputs: given, target: { phase }, reasonCodes: [] } };
    for (const exactSubmit of [false, true]) for (const route of decisionRoutes(decision, workflow, workflow.phases[phase], { exactSubmit })) {
      assert.ok(route?.command, `${operation} ${JSON.stringify(given)}: a route with a command`);
      const words = route.command.replace(/^singularity-flow /u, '');
      const forms = Object.values(ACTION_COMMANDS).flatMap((entry) => Object.keys(entry.forms).map((form) => [entry, form]));
      const named = Object.entries(ACTION_COMMANDS).some(([op, entry]) => Object.keys(entry.forms).some((form) => {
        const filled = actionCommand(op, form, { step: phase, workId: W });
        return filled === words || (op === 'submit-version' && form === 'exact' && words.startsWith(filled));
      }));
      assert.ok(forms.length && named, `${operation} rendered '${route.command}', which no named form of the map gives`);
      rendered += 1;
    }
  }
  assert.ok(rendered > 100);
});

test('the planners take their routes from the map: the same commands and skills they always showed [§10, OSA:REQ-021]', () => {
  const step = (id, task, status, extra = {}) => ({ id, label: id, status, generation: 1, writeScope: task === 'code' ? 'source-and-artifact' : 'artifact-only',
    generationPolicy: { requirement: 'required', task }, approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] }, ...extra });
  const workflow = { schemaVersion: 13, workItem: { id: W }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['intake', 'implement'], history: [],
    phases: { intake: step('intake', 'document', 'approved'), implement: step('implement', 'code', 'awaiting_approval') }, resolution: {} };
  const { intake, implement } = workflow.phases;
  // Each helper is a form of the map filled in, written out as the planners wrote it in place before.
  assert.equal(authorCommand('intake'), 'singularity-flow prepare intake');
  assert.deepEqual(authorRoute(workflow, intake), { skill: '/sf-phase', command: 'singularity-flow prepare intake' });
  assert.deepEqual(authorRoute(workflow, implement), { skill: '/sf-code', command: 'singularity-flow prepare implement' });
  assert.equal(showCommand('implement'), 'singularity-flow phase show implement --json');
  assert.equal(storyNextCommand(W), `singularity-flow nextsteps ${W}`);
  assert.equal(versionPreviewCommand('implement'), 'singularity-flow phase rollover implement --json');
  assert.equal(versionQuestionRoute(workflow, implement).command, 'singularity-flow phase rollover implement --reason "<what to change>" --json');
  assert.deepEqual(handoffSubmitRoute(workflow, implement), { skill: '/sf-submit', command: 'singularity-flow submit implement' });
  assert.deepEqual(approveRoute(workflow, implement), { skill: '/sf-approve', command: `singularity-flow approve implement --work-id ${W} --fetch` });
  assert.deepEqual(returnRoute(workflow, implement), { skill: '/sf-reject', command: `singularity-flow reject implement --work-id ${W} --fetch --to implement --reason <reason>` });
  assert.equal(returnRoute(workflow, implement, 'intake').command, `singularity-flow reject implement --work-id ${W} --fetch --to intake --reason <reason>`);
  // A form keeps its placeholder where no step is given: the renderer's own return route is unchanged.
  assert.equal(actionCommand('approve-step', 'reject', { step: 'implement', workId: W }), `reject implement --work-id ${W} --fetch --to <phase> --reason <reason>`);
  // The guide's approval pair, through the map.
  const routes = workflowGuide(workflow).nextActions.map((entry) => [entry.skill, entry.command]);
  assert.deepEqual(routes.slice(0, 2), [['/sf-approve', `singularity-flow approve implement --work-id ${W} --fetch`],
    ['/sf-reject', `singularity-flow reject implement --work-id ${W} --fetch --to implement --reason <reason>`]]);
  // Its version question says "version", never "generation" or "draft N" [owner: the person's word is version].
  workflow.phases.implement = { ...implement, status: 'in_progress', generationIntent: { id: 'GI-1', status: 'consumed', generation: 1 } };
  for (const options of [{ requested: true }, {}, { changedPaths: ['README.md'] }]) {
    const offered = requestedSuccessorAction(workflow, workflow.phases.implement, options);
    assert.match(offered.reason, /\bversion 2 of implement\b/u, JSON.stringify(options));
    assert.doesNotMatch(offered.reason, /\bgeneration\b|\bdraft \d/u, offered.reason);
    assert.equal(offered.command, options.changedPaths || options.requested ? versionPreviewCommand('implement') : versionQuestionRoute(workflow, workflow.phases.implement).command);
  }
});

// ------------------------------------------------------------------------------------------- refusals that named recovery

test('refusals that named recovery for healthy work name their continuation, and keep their codes [D4, OSA:REQ-011, REQ-022, AC-006]', () => {
  const plan = (code, details = {}) => refusalRemediationPlan(new SingularityFlowError('refused', { code, details: { workId: W, phase: 'implement', ...details } }), ['phase', 'publish', 'implement']);
  for (const code of ['TRP_PUBLICATION_PENDING', 'TCA_PUBLICATION_PENDING']) {
    const refused = plan(code);
    assert.equal(refused.code, code, 'the original code is kept');
    assert.equal(refused.steps[0].command, 'singularity-flow sync', `${code}: a pending publication is sent as it is`);
    assert.doesNotMatch(JSON.stringify(refused.steps), /singularity-flow recover\b|\/sf-recover/u, code);
  }
  for (const code of ['CODE_TEST_RESULT_REQUIRED', 'CODE_TEST_SUPPRESSED']) {
    const pinned = plan(code, { configurationDependency: true });
    assert.equal(pinned.steps[0].command, 'singularity-flow story test-policy show --json', `${code}: the pinned policy is read`);
    assert.doesNotMatch(JSON.stringify(pinned.steps), /singularity-flow recover\b|\/sf-recover/u, code);
  }
  // A coverage refusal's own recheck lists what is still open; it carries no recovery read.
  const coverage = plan('SPEC_COVERAGE_INCOMPLETE', { coverage: { unimplemented: ['US-1:REQ-001'] } });
  assert.equal(coverage.steps.find((entry) => entry.id === 'deliver-missing-clauses').command, 'singularity-flow phase prepublish implement --for-agent --json');
  assert.doesNotMatch(JSON.stringify(coverage.steps), /singularity-flow recover\b/u);
});

test('a healthy step is never sent to recovery by its producer: an earlier step owes clauses, a finding repeats, a publication is pending [D4, owner decision 4]', async () => {
  // No clauses before the code step: the specification's own correction leads, the refusal, its gate and its plan alike.
  const step = (id, status, generation = 1) => ({ id, label: id, status, generation, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] } });
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['specification', 'planning', 'code'],
    phases: { specification: step('specification', 'approved'), planning: step('planning', 'in_progress'), code: step('code', 'not_started', 0) },
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['specification'] } } };
  const error = noSpecificationClausesError(workflow, 'code');
  assert.equal(error.code, 'SPECIFICATION_CLAUSE_SOURCE_REQUIRED', 'the code is kept');
  assert.equal(error.details.nextAction.command, upstreamChangeRoutes(workflow, 'specification').routes[0].command);
  assert.match(error.details.nextAction.command, /^singularity-flow (?:upstream-issue raise|story intent-amendment propose) /u);
  assert.equal(error.details.recoveryCommand, undefined);
  assert.equal(error.details.gate.actions[0].command, error.details.nextAction.command);
  const plan = refusalRemediationPlan(error, ['phase', 'publish', 'planning']);
  assert.ok(plan.steps.some((entry) => entry.command === error.details.nextAction.command), JSON.stringify(plan.steps));
  assert.doesNotMatch(JSON.stringify(plan.steps), /singularity-flow recover\b|\/sf-recover/u);
  // A finding that keeps returning is read where the step stands; its instruction says to stop recovering.
  const escalation = findingEscalation({ count: ESCALATION_THRESHOLD, code: 'artifact.placeholder.unresolved', workId: W, phaseId: 'implement' });
  assert.equal(escalation.routes.find((route) => route.kind === 'inspect').command, 'singularity-flow phase show implement --json');
  assert.doesNotMatch(JSON.stringify(escalation.routes), /singularity-flow recover\b/u);
  // A pending Story publication is continued by `sync` wherever its legal action is named.
  for (const file of ['story-test-risk.mjs', 'story-test-command-amendment.mjs', 'commands/story-test-selection.mjs', 'commands/story-test-repair.mjs']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.match(source, /id: 'sync-publication'[^}]*command: 'sync', args: \[\]/u, file);
    assert.doesNotMatch(source, /command: 'recover'|Recover the exact pending/u, file);
  }
});

// ------------------------------------------------------------------------------------------- activation and reversal

test('Stage 5 writes no new record: the kernel admits exactly the Story records Stages 2-4 write, with the same lifecycle events [§14, docs/osa/activation.md]', () => {
  assert.deepEqual(RECORD_ADMISSION['story-workflow'], { min: 1, max: 13 });
  assert.equal(currentSchemaVersion('story-workflow'), 13, 'the Story record a Stage 5 build writes is the one Stages 2-4 write');
  for (const event of ['version-opened', 'version-writer-taken-over']) assert.ok(LIFECYCLE_EVENT_TYPES.includes(event), event);
});

/** Every file of the checkout (Git's own files too), by path and digest. */
async function tree(root) {
  const entries = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) entries.push([path.relative(root, file), createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
  };
  await walk(root);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

test('read-only surfaces leave a Story with an accepted opening unchanged: its record, opening, receipt, attachments and refs [plan section 7, §14]', async (t) => {
  const f = await story(t);
  // A local attachment never in Git, and the opening's checkpoint and writer under the Git directory.
  await mkdir(path.join(f.root, '.sflow', 'attachments'), { recursive: true });
  await writeFile(path.join(f.root, '.sflow', 'attachments', 'brief.pdf'), 'local attachment');
  const before = await tree(f.root);
  // Outside the Story: the machine-local prompt log a turn's start appends to, and Git's index stat cache.
  const outside = (file) => !file.startsWith('.git/singularity-flow/prompts/') && !file.startsWith('.git/index');
  // Every read the views, the entry's permission and the guard make of this Story.
  const opening = observeOpening(f.root, f.workflow, f.implement);
  const task = await readTaskOutcome(f.root, f.workflow, f.implement);
  await readGuardTaskOutcome(f.root, f.workflow, f.implement);
  views(f.workflow, task);
  deriveMutationContract({ root: f.root, definition: f.definition, workflow: f.workflow, turnMode: 'view', opening, task });
  const turn = await f.enter('/sf-nextsteps');
  await f.write(turn, 'src/App.java');
  const after = await tree(f.root);
  const changed = Object.keys({ ...before, ...after }).filter((file) => before[file] !== after[file] && outside(file));
  // The guard prepares the step's own staging folders only (empty directories), never a file of the Story.
  assert.deepEqual(changed, [], 'no Story, opening, receipt, attachment or ref byte changed');
  assert.equal(after['.sflow/attachments/brief.pdf'], before['.sflow/attachments/brief.pdf']);
});

test('a fenced writer stays out when the machine\'s turn records are lost, as a reinstall or a reversal of the host side loses them [§7.3, OSA:REQ-034, AC-017]', async (t) => {
  const f = await story(t);
  const turn = await f.enter('/sf-code');
  assert.deepEqual(await f.write(turn, 'src/App.java'), {}, 'version 2 open and held here');
  // Another checkout takes the writer fence over through the verified takeover.
  f.implement.versionOpening.writer = { ...f.implement.versionOpening.writer, fence: 2, writerId: `vw-${'f'.repeat(32)}` };
  await f.save();
  // Every turn record this machine kept is gone.
  await rm(path.join(f.directory, 'machine'), { recursive: true, force: true });
  const fresh = await f.enter('/sf-code');
  const refused = await f.write(fresh, 'src/App.java');
  assert.equal(refused.permissionDecision, 'deny', 'the fence is read from the Story record and this checkout\'s writer, never from a cache');
  assert.match(refused.permissionDecisionReason, new RegExp(`singularity-flow session takeover ${W} --json`, 'u'));
  // The accepted opening itself is untouched: still version 2, its operation and record path as accepted.
  assert.equal(f.implement.versionOpening.version, 2);
  const decision = stepState(stepSnapshotOf({ workflow: f.workflow, turnMode: 'authoring', opening: observeOpening(f.root, f.workflow, f.implement) }));
  assert.deepEqual([decision.state, decision.next.operation, decision.version.writing], ['held', 'takeover-writer', 2]);
});

test('a stale outcome is never applied: a lifecycle event after it returns the step to the kernel\'s own decision [§4.1, §8]', async (t) => {
  const f = await story(t);
  const record = { id: 'WT-x', state: 'blocked', repairConsumed: 2, maximumContinuations: 2, blockedCode: outcomeCode('repair-required', 'CODE_TEST_FAILED', f.workflow) };
  assert.equal(taskOutcomeOf(record, f.workflow).outcome, 'repair-required');
  const moved = { ...f.workflow, history: [...f.workflow.history, { at: '2026-11-17T09:00:00.000Z', event: 'phase_generated', phase: 'implement' }] };
  assert.equal(taskOutcomeOf(record, moved), null, 'the person decided, or the step published: the outcome no longer applies');
});

test('the guard is handed the repair and running stages only: a wait for a person keeps the turn\'s writes while every view names it (journey E) [§8, owner decision]', async (t) => {
  const f = await story(t);
  await observeWorkflowTask(f.root, f.workflow, f.implement, { state: 'blocked', blockedCode: outcomeCode('waiting-person', 'CODE_TEST_FAILED', f.workflow) });
  const waiting = await readTaskOutcome(f.root, f.workflow, f.implement);
  assert.equal(waiting.outcome, 'waiting-person');
  for (const command of Object.values(views(f.workflow, waiting))) assert.equal(command, `singularity-flow decisions ${W}`, 'every view names the card');
  const guard = await readGuardTaskOutcome(f.root, f.workflow, f.implement);
  assert.equal(guard.task, null, 'the wait is not handed to the guard');
  assert.equal(guard.files.length, 1, 'its record is still stamped, so a repair spent later derives the turn again');
  const turn = await f.enter('/sf-code');
  assert.deepEqual(await f.write(turn, 'src/App.java'), {}, 'the turn that asked keeps the version\'s writes while the person decides');
});
