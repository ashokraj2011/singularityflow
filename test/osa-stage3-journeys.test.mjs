/**
 * SPEC-OSA v1.1 Stage 3 qualification journeys (implementation plan section 5, "Qualification"), through the real pre-tool
 * guard (mutationToolGuard), the real lease, task and consent stores, and the views every surface renders:
 *   - a long-running execution with a live heartbeat, an expired interaction window and a resumed task;
 *   - a revoked writer permission and an expired yes (required presence), which the person's answer renews neither of;
 *   - a missing local attachment, a missing file and a permission error, each with its own code and route;
 *   - a failed test with bounded repair, stopping at its boundary and never taking the same route twice;
 *   - a malformed review citation, repaired inside its own review task;
 *   - a stale screen, a switched Story and a concurrent window; text in the composer and unavailable prefill only as the
 *     host-neutral action the engine gives (VS Code's own prefill is test/osa-stage3-vscode.test.mjs);
 *   - no-progress loops told apart from observation, a declared wait and an idempotent acknowledgement;
 *   - (slow lane) a publication left pending by an interruption, and a published document edited in place, through the CLI.
 * Expected results are written out here from the specification (§5, §6, §8), never computed by the code under test.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { recordRepositoryBoundaryTurn, repositoryPostToolGuard } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { noProgress, stepState } from '../src/kernel/step-state.mjs';
import { decisionRoutes, stepDecisionOf, stepSnapshotOf } from '../src/step-decision.mjs';
import { outcomeCode, readTaskOutcome, taskOutcomeOf } from '../src/workflow-task-outcome.mjs';
import { inspectSubjectLease } from '../src/subject-lock.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { workflowTaskResume } from '../src/workflow-task.mjs';
import { observeWorkflowTask, readWorkflowTaskResume, resumeWorkflowTask } from '../src/workflow-task-store.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { consentProblem, consentReceipt, grantConsent, readGrant, recordProposal } from '../src/story-version-consent.mjs';
import { gitDirectories, observeOpening } from '../src/story-version-acceptance.mjs';
import { sourceReviewStagingPath } from '../src/phase-staging-paths.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { acceptOpening } from './helpers/accepted-opening.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const MINUTE = 60_000;
const W = 'OSA-J3';
const EXPIRED = /^PHASE_MUTATION_TURN_EXPIRED/u;
const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

/**
 * A Story at its code step `implement` with version 2 open through the opening operation (accepted, held here), after an
 * approved `design`; `verify` follows. A real Git checkout, as the guard reads it.
 */
async function story(t, { open = true, review = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-osa-j3-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q'); git('config', 'user.name', 'Stage Three'); git('config', 'user.email', 'stage3@example.test');
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
    resolution: review ? { sourceReview: { mode: 'enforce', phases: ['implement'], kinds: { implement: 'code' }, reviewerAgent: 'sflow-source-reviewer' } } : {} };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  if (open) await acceptOpening(root, workflow, implement);
  const workflowFile = path.join(root, 'singularity', 'work-items', W, 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', 'fixture');
  const accepted = { definition, workflow };
  let sessions = 0;
  /** A skill's turn whose prompt came `ago` milliseconds before now. */
  const enter = async (skill, { ago = 0, sessionId = `osa-j3-${sessions += 1}` } = {}) => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now: Date.now() - ago, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  const write = (turn, target) => mutationToolGuard({ ...turn, toolName: 'edit', toolArgs: { path: target } });
  const save = () => writeFile(workflowFile, JSON.stringify(workflow));
  return { root, directory, workflow, definition, implement, enter, write, save, git };
}

/** What every view names as the step's next action, at one basis [OSA:REQ-020]: kernel route, next steps, guide, readiness. */
function views(workflow, taskOutcome) {
  const phase = workflow.phases[workflow.currentPhase];
  return {
    kernel: decisionRoutes(stepDecisionOf(workflow, phase, { task: taskOutcome }), workflow, phase)[0].command,
    next: workflowNextSteps(workflow, { taskOutcome, pendingDecisions: null }).find((entry) => entry.timing === 'now')?.command,
    guide: workflowGuide(workflow, { taskOutcome }).nextActions[0]?.command,
    readiness: submissionReadinessSnapshot(workflow, { taskOutcome }).command
  };
}

const allAre = (named, command) => assert.deepEqual(named, { kernel: command, next: command, guide: command, readiness: command });

// ------------------------------------------------------------------------------------------------------------------------

test('a long-running execution with a live heartbeat is observed by every view, renews no turn, and the resumed task goes on [§8, OSA:REQ-012, REQ-051, AC-012, AC-021]', async (t) => {
  const f = await story(t);
  // Another process on this laptop holds the Story's lease, as a long quality command does, and renews its heartbeat.
  const ready = path.join(f.directory, 'execution-ready'), stop = path.join(f.directory, 'execution-stop');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync, existsSync } from 'node:fs';
    const { withSubjectLock } = await import(${JSON.stringify(pathToFileURL(path.join(SOURCE, 'subject-lock.mjs')).href)});
    await withSubjectLock(${JSON.stringify(f.root)}, { kind: 'story', id: ${JSON.stringify(W)} }, async () => {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      while (!existsSync(${JSON.stringify(stop)})) await new Promise((resolve) => setTimeout(resolve, 50));
    });`], { stdio: 'ignore', env: process.env });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let waited = 0; !existsSync(ready); waited += 50) {
    assert.ok(waited < childTimeout(60_000), 'the execution never took its lease');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const lease = await inspectSubjectLease(f.root, { kind: 'story', id: W });
  assert.deepEqual([lease.held, lease.liveness.state, lease.liveness.reason, lease.liveness.heartbeat], [true, 'alive', 'process-running', 'fresh'],
    'a live process with a renewed heartbeat holds the Story');

  // Every view observes it: the same read, and nothing is started again while it runs.
  const running = await readTaskOutcome(f.root, f.workflow, f.implement);
  assert.deepEqual([running.outcome, running.code], ['running', 'STORY_LEASE_HELD']);
  const decision = stepDecisionOf(f.workflow, f.implement, { task: running });
  assert.deepEqual([decision.state, decision.next.kind, decision.next.operation, decision.task.status], ['waiting', 'observe', 'inspect', 'running']);
  allAre(views(f.workflow, running), 'singularity-flow session current --for-agent --json');
  // Observing a running execution again and again is its progress, never a loop [AC-012].
  assert.deepEqual(noProgress([1, 2, 3].map(() => ({ decision, basisKey: 'heartbeat' }))), { loop: false });

  // The heartbeat keeps the execution alive; it renews no turn. A turn whose 30 minutes ended writes nothing [AC-021].
  const old = await f.enter('/sf-code', { ago: 31 * MINUTE });
  assert.match((await f.write(old, 'src/App.java')).permissionDecisionReason ?? '', EXPIRED);
  // A fresh turn on the open version still writes it: the execution is observed, never called damaged [§5].
  assert.deepEqual(await f.write(await f.enter('/sf-code'), 'src/App.java'), {});

  // The execution ends; its lease goes; the step's task resumes where it was, from the same record.
  await writeFile(stop, 'stop');
  await exited;
  assert.equal((await inspectSubjectLease(f.root, { kind: 'story', id: W })).held, false);
  assert.equal(await readTaskOutcome(f.root, f.workflow, f.implement), null);
  allAre(views(f.workflow, null), 'singularity-flow prepare implement');
  const first = await resumeWorkflowTask(f.root, f.workflow, f.implement, { progress: { state: 'author-draft' } });
  const again = await readWorkflowTaskResume(f.root, f.workflow, f.implement);
  assert.equal(first.resumed, false);
  assert.deepEqual([again.resumed, again.operationId, again.complete], [true, first.operationId, false], 'another turn resumes the same task');
});

test('a revoked writer and an expired yes stop the step; the person\'s answer renews the turn but revives neither [§6, OSA:REQ-051, AC-021]', async (t) => {
  const f = await story(t);
  const turn = await f.enter('/sf-code');
  assert.deepEqual(await f.write(turn, 'src/App.java'), {}, 'version 2 open and held here: its source is written');

  // Another checkout takes the version's writer fence over (a verified takeover): this one's grant is revoked at its next
  // write, whatever its screen still shows, and the takeover is the person's to undo [OSA:REQ-034, §6].
  f.implement.versionOpening.writer = { ...f.implement.versionOpening.writer, fence: 2, writerId: `vw-${'e'.repeat(32)}` };
  await f.save();
  const fenced = await f.write(turn, 'src/App.java');
  assert.equal(fenced.permissionDecision, 'deny');
  assert.match(fenced.permissionDecisionReason, /^[A-Z][A-Z_]+[: ]/u, 'the refusal keeps its code');
  const held = stepState(stepSnapshotOf({ workflow: f.workflow, turnMode: 'authoring', opening: observeOpening(f.root, f.workflow, f.implement) }));
  assert.deepEqual([held.state, held.next.operation, held.edit.eligible], ['held', 'takeover-writer', false]);
  assert.equal(decisionRoutes(held, f.workflow, f.implement)[0].command, `singularity-flow session takeover ${W} --json`);

  // A yes given 31 minutes ago to starting version 3 (required presence) has expired: no grant, no consent [OSA:REQ-030].
  const { commonDir } = gitDirectories(f.root);
  const proposal = { schema: 'version-opening-proposal/v1', workId: W, phase: 'implement', step: 'Implement', version: 3, from: { published: 2 }, confirmation: 'J3-CONFIRM' };
  const record = await recordProposal(commonDir, { proposal, digest: `sha256:${'d'.repeat(64)}`, question: 'Start version 3 of Implement? Published version 2 will stay unchanged.',
    confirmation: 'J3-CONFIRM', now: Date.now() - 31 * MINUTE });
  await grantConsent(commonDir, { record, surface: 'question-tool', question: record.question, now: Date.now() - 31 * MINUTE });
  assert.equal(await readGrant(commonDir, record.digest), null, 'an expired yes is no grant');
  const receipt = consentReceipt(commonDir, { proposal, digest: record.digest, surface: 'question-tool', question: record.question,
    principal: { name: 'Stage Three' }, assurance: 'host-answer', confirmedAt: Date.now() - 31 * MINUTE });
  assert.equal(consentProblem(commonDir, receipt, { digest: record.digest, proposal }).code, 'VERSION_CONSENT_EXPIRED');

  // The person answers in a turn whose window ended: the answer renews that turn, and only that.
  const late = await f.enter('/sf-code', { ago: 31 * MINUTE });
  assert.match((await f.write(late, 'singularity/work-items/OSA-J3/artifacts/implement/summary.md')).permissionDecisionReason ?? '', EXPIRED);
  await repositoryPostToolGuard({ ...late, toolName: 'ask_user', toolArgs: { question: 'Go on?' },
    toolResult: { resultType: 'success', textResultForLlm: 'User responded: yes, go on' } });
  assert.doesNotMatch(String((await f.write(late, 'singularity/work-items/OSA-J3/artifacts/implement/summary.md')).permissionDecisionReason ?? ''), EXPIRED,
    'the person\'s answer renewed the turn');
  assert.equal(await readGrant(commonDir, record.digest), null, 'the renewed turn revives no expired yes');
  assert.equal(consentProblem(commonDir, receipt, { digest: record.digest, proposal }).code, 'VERSION_CONSENT_EXPIRED');
  assert.equal((await f.write(late, 'src/App.java')).permissionDecision, 'deny', 'nor the revoked writer');
});

test('a missing local attachment waits for the person; a missing file and a permission error keep their own codes and routes [OSA:REQ-012, REQ-022, AC-006]', async (t) => {
  const f = await story(t);
  // The input the step needs is not on this laptop (a machine-local document): the task waits for the person to restore
  // the same original; its record keeps the wait, every view names it and nothing is repeated meanwhile.
  const kept = await observeWorkflowTask(f.root, f.workflow, f.implement, { state: 'blocked',
    blockedCode: outcomeCode('waiting-input', 'DOCUMENT_REUPLOAD_REQUIRED', f.workflow) });
  const waiting = await readTaskOutcome(f.root, f.workflow, f.implement);
  assert.deepEqual([waiting.outcome, waiting.code], ['waiting-input', 'DOCUMENT_REUPLOAD_REQUIRED'], 'read back from the task record, as a later turn reads it');
  allAre(views(f.workflow, waiting), `singularity-flow documents readiness --phase implement --work-id ${W} --json`);
  const decision = stepDecisionOf(f.workflow, f.implement, { task: waiting });
  assert.deepEqual([decision.next.principalKind, decision.next.inputs, decision.edit.eligible], ['human', { code: 'DOCUMENT_REUPLOAD_REQUIRED' }, false]);
  assert.deepEqual(noProgress([{ decision, basisKey: 'b' }, { decision, basisKey: 'b' }]), { loop: false }, 'a declared wait is no loop');
  const resumed = workflowTaskResume(f.workflow, f.implement, { record: kept });
  assert.deepEqual([resumed.state, resumed.nextAction.command, resumed.nextAction.code], ['blocked', `singularity-flow documents readiness --phase implement --work-id ${W} --json`, 'DOCUMENT_REUPLOAD_REQUIRED']);

  // A required file that is missing keeps its code, and the step's own author creates it: no recovery of healthy work.
  const missing = phaseResolutionChoices(f.workflow, f.implement, { code: 'artifact.required.missing', path: 'artifacts/implement/summary.md' });
  assert.equal(missing.code, 'artifact.required.missing');
  assert.doesNotMatch(JSON.stringify(missing.choices.map((choice) => choice.command)), /singularity-flow recover\b/u);
  // A refusal for a file the command could not find keeps its code and details; its first route is the producer's own,
  // then the step's own next-step read, never recovery [D4, OSA:REQ-022].
  const notFound = refusalRemediationPlan(new SingularityFlowError('Required artifact is missing: artifacts/implement/summary.md.',
    { code: 'PHASE_ARTIFACT_MISSING', details: { workId: W, phase: 'implement', path: 'artifacts/implement/summary.md',
      nextAction: { command: 'singularity-flow prepare implement', skill: '/sf-code', label: 'Write it in its own step.' } } }), ['phase', 'publish', 'implement']);
  assert.equal(notFound.code, 'PHASE_ARTIFACT_MISSING');
  assert.deepEqual(notFound.steps.map((entry) => entry.command), ['singularity-flow prepare implement', `singularity-flow nextsteps ${W} --json`]);

  // A write the turn may not make (another step's artifact) is refused by the real guard with its code, before any byte
  // changes, and leads with the step's own next action [OSA:REQ-010, AC-010]. Since Stage 5 the guard reads the task stage
  // too, so while the task waits for the input that next action is the wait's, as on every view above.
  const turn = await f.enter('/sf-code');
  const denied = await f.write(turn, `singularity/work-items/${W}/artifacts/verify/report.md`);
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /^PHASE_MUTATION_PATH_DENIED/u);
  assert.equal(denied.next[0].command, `singularity-flow documents readiness --phase implement --work-id ${W} --json`);
  assert.equal(existsSync(path.join(f.root, `singularity/work-items/${W}/artifacts/verify/report.md`)), false);
});

test('a failed test is repaired within its budget, stops at a person\'s decision when spent, and never takes the same route twice [§8, OSA:REQ-003, REQ-012, AC-012]', async (t) => {
  const f = await story(t);
  const record = (used) => ({ id: `WT-${'b'.repeat(64)}`, state: 'blocked', repairConsumed: used, maximumContinuations: 2,
    blockedCode: outcomeCode('repair-required', 'CODE_TEST_FAILED', f.workflow) });
  // Within the budget: the step's own repair, then publication; its version stays writable for it.
  const first = stepDecisionOf(f.workflow, f.implement, { task: taskOutcomeOf(record(0), f.workflow) });
  const second = stepDecisionOf(f.workflow, f.implement, { task: taskOutcomeOf(record(1), f.workflow) });
  assert.deepEqual([first.next.operation, first.next.inputs], ['repair-version', { code: 'CODE_TEST_FAILED', attempt: 1, budget: 2 }]);
  assert.deepEqual(second.next.inputs, { code: 'CODE_TEST_FAILED', attempt: 2, budget: 2 });
  allAre(views(f.workflow, taskOutcomeOf(record(1), f.workflow)), 'singularity-flow prepare implement');
  // Spent: a person decides on the decisions card, the evidence of each attempt kept; the repair is never offered again.
  const spent = stepDecisionOf(f.workflow, f.implement, { task: taskOutcomeOf(record(2), f.workflow) });
  assert.deepEqual([spent.next.kind, spent.next.operation, spent.next.inputs.outcome, spent.next.inputs.attempts], ['person-decision', 'decide', 'repair-exhausted', 2]);
  allAre(views(f.workflow, taskOutcomeOf(record(2), f.workflow)), `singularity-flow decisions ${W}`);
  // Each attempt changed the basis (a new run): progress. The same repair on an unchanged basis would be a loop.
  assert.deepEqual(noProgress([{ decision: first, basisKey: 'run-1' }, { decision: second, basisKey: 'run-2' }, { decision: spent, basisKey: 'run-2' }]), { loop: false });
  assert.equal(noProgress([{ decision: second, basisKey: 'run-2' }, { decision: second, basisKey: 'run-2' }]).loop, true);
  // The refusal and the finding name the repair in the step and the saved log; no recovery beside a failed test (owner,
  // 2026-11-17) [§5, OSA:REQ-003].
  const plan = refusalRemediationPlan(new SingularityFlowError('Required test failed.', { code: 'CODE_TEST_FAILED',
    details: { workId: W, phase: 'implement' } }), ['phase', 'publish', 'implement']);
  assert.equal(plan.code, 'CODE_TEST_FAILED');
  assert.equal(plan.steps[0].command, 'singularity-flow phase prepublish implement --for-agent --json --publish-if-ready');
  assert.doesNotMatch(JSON.stringify(plan.steps), /singularity-flow recover\b|\/sf-recover/u);
  const finding = phaseResolutionChoices(f.workflow, f.implement, { code: 'code.delivery.incomplete', details: { sourceCode: 'CODE_TEST_FAILED' } });
  assert.equal(finding.choices[0].command, 'singularity-flow phase prepublish implement --for-agent --json --publish-if-ready');
  assert.doesNotMatch(JSON.stringify(finding.choices.map((choice) => choice.command)), /singularity-flow recover\b/u);
});

test('a malformed review citation is repaired inside its own review task; no new product version is opened for it [§5, OSA:REQ-013]', async (t) => {
  const f = await story(t, { open: false, review: true });
  // The reviewer's turn writes only its exact staging report, never the step's source or artifact [OSA:REQ-013, AC-010].
  const reviewer = await f.enter('/sf-review-source');
  const staging = sourceReviewStagingPath(gitDir(f.root), f.workflow, f.implement);
  assert.deepEqual(await f.write(reviewer, staging), {});
  for (const target of ['src/App.java', `singularity/work-items/${W}/artifacts/implement/summary.md`]) {
    assert.equal((await f.write(reviewer, target)).permissionDecision, 'deny', target);
  }
  // Its report's citation failed the check: the review task repairs its own report and checks it again.
  const task = workflowTaskResume(f.workflow, f.implement, { role: 'source-reviewer', review: { state: 'repair-report' } });
  assert.deepEqual(task.remaining, ['repair', 'check', 'retain']);
  assert.equal(task.nextAction.command, 'singularity-flow review-source context implement --for-agent --json');
  // The step stays in review: no successor, no consent asked, no product edit for a report's own repair.
  const decision = stepDecisionOf(f.workflow, f.implement, { review: { status: 'pending', generation: 1, findings: [] } });
  assert.deepEqual([decision.state, decision.next.operation, decision.edit.eligible], ['in-review', 'start-review', false]);
  assert.notEqual(decision.next.operation, 'open-version');
});

test('a stale screen, a switched Story and a concurrent window are decided at the write, from the record as it is now [§4.1, §6, OSA:REQ-020, REQ-050]', async (t) => {
  const f = await story(t);
  // A view that did not observe the opening names its writing as advisory, with its basis; it grants nothing [§4.1].
  const advisory = stepState(stepSnapshotOf({ workflow: f.workflow, turnMode: 'view' }));
  assert.deepEqual([advisory.next.operation, advisory.edit.eligible], ['author-version', false]);
  assert.ok(advisory.next.reasonCodes.includes('OPENING_UNOBSERVED'));
  assert.ok(['verified', 'partial', 'stale'].includes(advisory.basis.freshness));
  // Two windows on the same Story and step: each writes its open version.
  const one = await f.enter('/sf-code', { sessionId: 'window-one' });
  const two = await f.enter('/sf-code', { sessionId: 'window-two' });
  assert.deepEqual(await f.write(one, 'src/App.java'), {});
  assert.deepEqual(await f.write(two, 'src/App.java'), {});
  // Window one publishes version 2: the screen window two still shows is stale, and its next write is refused at the
  // boundary, from the record as it is now [§6 "A moved lifecycle revision invalidates an earlier grant"].
  Object.assign(f.implement, { generation: 2, generationIntent: { id: 'GI-2', status: 'consumed', generation: 2 },
    generationPublications: [...f.implement.generationPublications, { generation: 2, record: { path: `singularity/work-items/${W}/publications/implement-2.json`, sha256: `sha256:${'f'.repeat(64)}` } }] });
  delete f.implement.versionOpening;
  await f.save();
  assert.equal((await f.write(two, 'src/App.java')).permissionDecision, 'deny', 'the concurrent window\'s stale grant is gone');
  // A switched Story: the turn is bound to this Story; another Story's files are never this turn's to write.
  assert.equal((await f.write(one, 'singularity/work-items/OTHER-1/artifacts/implement/summary.md')).permissionDecision, 'deny');
  // Text in the composer and unavailable prefill: the engine gives one host-neutral action, a Shell line and a Copilot
  // line, and says plainly when there is no model-free form; it never sends anything itself [§8 "Prefill", OSA:REQ-050].
  const [route] = decisionRoutes(stepDecisionOf(f.workflow, f.implement), f.workflow, f.implement, { exactSubmit: true });
  assert.equal(route.command, `singularity-flow submit implement --work-id ${W}`);
  assert.match(route.copilotCommand, /^\/sf-submit\b/u);
  assert.ok(['available', 'unavailable'].includes(route.modelFreeStatus));
  assert.equal(Object.hasOwn(route, 'send'), false);
});

test('an idempotent acknowledgement and a declared wait are no loop; the same action on an unchanged basis is [OSA:AC-012]', async (t) => {
  const f = await story(t);
  const writing = stepDecisionOf(f.workflow, f.implement);
  assert.deepEqual(noProgress([{ decision: writing, basisKey: 'b', acknowledgement: true }, { decision: writing, basisKey: 'b', acknowledgement: true }]), { loop: false });
  const loop = noProgress([{ decision: writing, basisKey: 'b' }, { decision: writing, basisKey: 'b' }]);
  assert.deepEqual(loop, { loop: true, first: 0, repeated: 1, actionId: 'author-version:implement@2' });
});

// ------------------------------------------------------------------------------------------------------------------------ slow lane

/** One laptop with a bare remote, a Story started on `feature`, and the CLI run in its own machine state. */
async function cliStory(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-osa-j3-cli-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const remote = path.join(base, 'remote.git'), repo = path.join(base, 'app'), state = path.join(base, 'machine');
  await mkdir(repo, { recursive: true }); await mkdir(state, { recursive: true });
  const env = { ...isolatedTestEnvironment(state, process.env), NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Packager',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const exec = (command, args, { cwd = repo, fail = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: childTimeout(180_000) });
    if (!fail && result.status !== 0) assert.fail(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  exec('git', ['init', '--bare', '-q', '-b', 'main', remote], { cwd: base });
  const git = (...args) => exec('git', args).stdout.trim();
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', remote);
  git('config', 'user.name', 'Packager'); git('config', 'user.email', 'packager@example.com');
  await writeFile(path.join(repo, 'README.md'), '# stage three journeys\n');
  const flow = (args, options) => exec(process.execPath, [CLI, ...args], options);
  flow(['init']);
  const file = path.join(repo, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.worldModel.grounding = 'off';
  for (const workType of Object.values(definition.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(file, YAML.stringify(definition));
  git('add', '.'); git('commit', '-qm', 'Initialize Singularity Flow'); git('push', '-q', '-u', 'origin', 'main');
  flow(['start', W, '--from-branch', 'main']);
  const intake = path.join(repo, `singularity/work-items/${W}/artifacts/intake/intake.md`);
  await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/gu, 'Keep every published version as it was published.'));
  return { base, remote, repo, git, flow, intake, json: (args, options) => JSON.parse(flow([...args, '--json'], options).stdout) };
}

test('a publication left pending by an interruption keeps its stage and exact continuation; a published document edited in place stays intact [§8, §6, OSA:REQ-012, REQ-014, D4]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const s = await cliStory(t);
    // The remote refuses the push: the version's publication is committed here and retained (the interruption).
    const hook = path.join(s.remote, 'hooks/pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
    const refused = s.flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place', '--json'], { fail: true });
    assert.notEqual(refused.status, 0, 'the remote refused the publication');
    const retained = s.git('rev-parse', 'HEAD');
    // Each later process reads the same stage from the sealed record: the same continuation, nothing authored again.
    const next = s.json(['nextsteps', W]);
    assert.equal(next.state, 'publication_pending');
    assert.equal(next.actions[0].command, 'singularity-flow sync');
    const session = s.json(['session', 'current']);
    assert.deepEqual([session.taskResume?.stage, session.taskResume?.nextAction?.command], ['publication-pending', 'singularity-flow sync']);
    assert.doesNotMatch(JSON.stringify([next.actions, session.taskResume]), /singularity-flow recover\b|\/sf-recover/u, 'a pending publication is no damage');
    // The remote takes it again: sync sends that exact commit; the stage ends and the Story goes on.
    await rm(hook);
    s.flow(['sync', W]);
    assert.equal(s.git('ls-remote', 'origin', `refs/heads/${s.git('branch', '--show-current')}`).split(/\s/u)[0], retained, 'the same commit was published');
    const after = s.json(['nextsteps', W]);
    assert.notEqual(after.state, 'publication_pending');
    assert.notEqual(s.json(['session', 'current']).taskResume?.stage, 'publication-pending');

    // The published intake is then edited in place: recovery keeps both the edit and the published bytes.
    const published = await readFile(s.intake, 'utf8');
    await writeFile(s.intake, `${published}\nAn edit made after publication.\n`);
    const plan = s.json(['recover', W, '--phase', 'intake']);
    const ids = plan.actions.map((action) => action.id);
    assert.ok(ids.includes('published-document-new-generation:intake'), ids.join(', '));
    const keep = plan.actions.find((action) => action.id === 'published-document-new-generation:intake');
    assert.equal(keep.command, 'singularity-flow phase rollover intake --reason "<what to change>" --json');
    assert.doesNotMatch(JSON.stringify(plan.actions.map((action) => action.command)), /phase publish intake/u, 'nothing publishes the edit in place');
    assert.match(await readFile(s.intake, 'utf8'), /An edit made after publication\./u, 'the edit is preserved');
    const at = s.git('log', '-1', '--format=%H', '--', path.relative(s.repo, s.intake));
    assert.equal(s.git('show', `${at}:${path.relative(s.repo, s.intake)}`), published.trimEnd(), 'the published bytes are unchanged');
    // Keeping it is the next version on the person's yes: the preview asks and opens nothing.
    const preview = s.json(['phase', 'rollover', 'intake', '--reason', 'Keep the edit made after publication']);
    assert.equal(preview.question, 'Start version 2 of Intake? Published version 1 will stay unchanged.');
    assert.equal(preview.mutates, false);
    assert.equal(s.json(['nextsteps', W]).actions.some((action) => /^singularity-flow prepare intake\b/u.test(action.command ?? '')), false,
      'no version opened before the yes');
  });
