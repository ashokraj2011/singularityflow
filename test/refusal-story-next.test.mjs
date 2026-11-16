/**
 * A refusal about where the Story stands names the Story's own next step [owner, 2026-11-16].
 *
 * An owner's Story (2026-11-16): the specification approved, planning in progress at generation 0. The person typed
 * /sf-review-source planning, and the refusal's only route was `singularity-flow help review-source`
 * (/sf-help); the agent ran it, then made up "reopen or attach the session with /sf-session". Planning
 * had not been written: the way on was /sf-phase (`singularity-flow prepare planning`), and the review
 * after it. Each refusal below was refused for the Story's state, and each fell back to command help,
 * or to recovering a step that needed none. Each now leads with the route sequence.mjs names for the
 * Story (storyNextDetails), the same guidance every sequence refusal uses.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { storyClosedRefusal, storyNextDetails } from '../src/sequence.mjs';
import {
  retainSourceReviewDecision, sourceReviewContext, sourceReviewDirectory, sourceReviewInput, sourceReviewStepNotCurrent
} from '../src/source-review-lifecycle.mjs';
import { sourceReviewDecisionPacket } from '../src/source-review-decision.mjs';
import { stageSourceReviewReport } from '../src/source-review-staging.mjs';
import { blockingDecisionFacts } from '../src/decision-list-facts.mjs';
import { commitRoutingChoice } from '../src/commands/decision-story-records.mjs';
import { refreshIntentAmendment } from '../src/commands/story.mjs';
import { approvalReviewBinding } from '../src/choices.mjs';
import { finalizeStoryDelivery } from '../src/story-lineage.mjs';
import { decideIntentAmendment, decideStory, reopenWorkflow } from '../src/state.mjs';

const WRITE_PLANNING = { shell: 'singularity-flow prepare planning', copilot: '/sf-phase' };
const APPROVE_SPECIFICATION = { shell: 'singularity-flow approve specification --work-id PLAN-0 --fetch', copilot: '/sf-approve specification --work-id PLAN-0' };
const REVIEWER = 'sflow-source-reviewer';

/** The owner's Story as it stood: the specification approved, planning in progress at generation 0. */
function unwrittenPlan(changes = {}) {
  const workflow = {
    workItem: { id: 'PLAN-0' }, status: 'in_progress', currentPhase: 'planning',
    phaseOrder: ['specification', 'planning', 'implementation'],
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvalPolicy: { mode: 'required' } },
      planning: { id: 'planning', label: 'Planning', status: 'in_progress', generation: 0, approvalPolicy: { mode: 'required' },
        requiredArtifact: { path: 'PLAN.md' } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'not_started', generation: 0,
        generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact', approvalPolicy: { mode: 'required' } }
    },
    resolution: { sourceReview: { kinds: { specification: 'specification', planning: 'planning' } } }
  };
  for (const [id, phase] of Object.entries(changes.phases ?? {})) Object.assign(workflow.phases[id], phase);
  return { ...workflow, ...changes, phases: workflow.phases };
}

/** The specification still awaiting approval, so planning has not started: the earlier step's route is the way on. */
const specificationAwaitingApproval = () => unwrittenPlan({ currentPhase: 'specification',
  phases: { specification: { status: 'awaiting_approval' }, planning: { status: 'not_started' } } });

async function refusalOf(operation) {
  try { await operation(); } catch (error) { return error; }
  assert.fail('the operation was not refused');
}

/** What the agent is told (`act`) and the whole plan, for a refusal read from `argv`. */
function routed(error, argv, { code, route }) {
  assert.equal(error.code, code, error.message);
  const envelope = refusalEnvelope(error, argv);
  const act = agentAct(envelope);
  const plan = envelope.remediationPlan;
  assert.equal(act.state, 'refused', JSON.stringify(act));
  assert.equal(act.do.shell, route.shell, `${code}: ${JSON.stringify(act.do)}`);
  assert.equal(act.do.copilot, route.copilot, code);
  assert.match(act.do.reason, /^Next for this Story: /u, code);
  assert.equal(plan.steps[0].id, 'story-next-action', code);
  assert.deepEqual(plan.steps.slice(1).map((entry) => entry.id), ['recommended-next'], code);
  assert.equal(plan.steps[1].command, 'singularity-flow nextsteps PLAN-0 --json', code);
  // Command help, repository diagnostics and phase recovery answer other refusals, never this one.
  assert.doesNotMatch(JSON.stringify(plan), /singularity-flow (?:help|doctor|recover)\b|\/sf-help|\/sf-recover|\/sf-session/u, code);
  assert.equal(plan.context, undefined, code);
  assert.equal(act.strategy, null, code);
  assert.match(plan.retry.label, /^Nothing was changed\. Take the Story's next step first/u, code);
  return { act, plan, envelope };
}

async function gitRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refusal-next-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

test('the owner\'s Story: reviewing a plan that has not been written routes to writing it (/sf-phase), never /sf-help', async () => {
  const error = await refusalOf(() => sourceReviewContext(null, {}, unwrittenPlan(), 'planning', null));
  assert.match(error.message, /'planning' has no published version yet, so there is nothing to review; review it once it is published\./u);
  for (const argv of [['review-source', 'context', 'planning', '--for-agent', '--json'], ['review-source', 'context', 'planning', '--json']]) {
    const { act, envelope } = routed(error, argv, { code: 'SOURCE_REVIEW_GENERATION_REQUIRED', route: WRITE_PLANNING });
    assert.match(act.said, /^SOURCE_REVIEW_GENERATION_REQUIRED: 'planning' has no published version yet/u);
    assert.equal(envelope.error.details.nextAction, WRITE_PLANNING.shell, 'every surface reading details.nextAction gets it too');
    assert.equal(envelope.error.details.phase, 'planning');
  }
});

test('a step not started because an earlier one is not approved routes to that earlier step', async () => {
  const workflow = specificationAwaitingApproval();
  routed(await refusalOf(() => sourceReviewContext(null, {}, workflow, 'planning', null)),
    ['review-source', 'context', 'planning', '--json'], { code: 'SOURCE_REVIEW_GENERATION_REQUIRED', route: APPROVE_SPECIFICATION });
  routed(sourceReviewStepNotCurrent(workflow, workflow.phases.planning, 'context'),
    ['review-source', 'context', 'planning', '--json'], { code: 'SOURCE_REVIEW_STEP_NOT_CURRENT', route: APPROVE_SPECIFICATION });
});

test('reviewing a step already approved, or one the Story is not at, routes to the Story\'s next step', () => {
  const workflow = unwrittenPlan();
  const error = sourceReviewStepNotCurrent(workflow, workflow.phases.specification, 'stage');
  assert.match(error.message, /needs 'specification' to be the Story's current step, in progress; it is approved and the Story is at 'planning'\./u);
  routed(error, ['review-source', 'stage', 'specification', '--report-json', '{}'], { code: 'SOURCE_REVIEW_STEP_NOT_CURRENT', route: WRITE_PLANNING });
});

test('a step name the Story lacks, and a step its review does not cover, route to the Story\'s next step', () => {
  const workflow = unwrittenPlan();
  const unknown = refusalOf(() => sourceReviewDirectory('/unused', {}, workflow, 'plannign'));
  return unknown.then((error) => {
    assert.match(error.message, /has no 'plannign' step; its steps are specification, planning, implementation\./u);
    routed(error, ['review-source', 'context', 'plannign', '--json'], { code: 'SOURCE_REVIEW_STEP_UNKNOWN', route: WRITE_PLANNING });
    return refusalOf(() => sourceReviewDirectory('/unused', {}, workflow, 'implementation'));
  }).then((error) => routed(error, ['review-source', 'submit', 'implementation', '--report-file', 'x.json'],
    { code: 'SOURCE_REVIEW_NOT_APPLICABLE', route: WRITE_PLANNING }));
});

test('a plan reviewed before its specification is approved routes to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  const sha256 = 'a'.repeat(64);
  const workflow = unwrittenPlan({ phases: { specification: { status: 'in_progress', generation: 1 }, planning: { status: 'in_progress', generation: 1 } } });
  workflow.resolution.agents = { [REVIEWER]: { sha256 } };
  workflow.resolution.obligationGraph = { nodes: [{ id: 'specification', responsibilities: ['scope'] }, { id: 'planning', responsibilities: ['plan'] }] };
  const config = { agents: { [REVIEWER]: { sha256, metadata: { 'sflow-mode': 'read-only-review' } } } };
  const error = await refusalOf(() => sourceReviewInput(root, config, workflow, 'planning'));
  routed(error, ['review-source', 'check', 'planning', '--report-file', 'x.json'],
    { code: 'SOURCE_REVIEW_SPEC_NOT_APPROVED', route: storyRoute(workflow) });
});

test('staging a review of a step that is not the current one routes to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  const error = await refusalOf(() => stageSourceReviewReport(root, {}, unwrittenPlan(), 'specification', '{}'));
  routed(error, ['review-source', 'stage', 'specification', '--report-json', '{}'], { code: 'SOURCE_REVIEW_STAGING_NOT_ACTIVE', route: WRITE_PLANNING });
});

test('deciding a review disposition that is not pending routes to the Story\'s next step', async () => {
  const workflow = unwrittenPlan();
  const status = { pendingDispositions: [], reportSha256: null, generation: 0 };
  routed(await refusalOf(() => sourceReviewDecisionPacket({ workflow, phaseId: 'planning', status, findingId: 'F-1', reason: 'Accepted.' })),
    ['review-source', 'decision-context', 'planning', '--finding', 'F-1', '--reason', 'Accepted.'],
    { code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING', route: WRITE_PLANNING });
  routed(await refusalOf(() => retainSourceReviewDecision('/unused', {}, workflow, 'planning', status, 'F-1', 'Accepted.')),
    ['review-source', 'decide', 'planning', '--finding', 'F-1', '--reason', 'Accepted.', '--confirm', 'x'],
    { code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING', route: WRITE_PLANNING });
});

test('choosing at a decision when none is waiting routes to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  const argv = ['decision', 'choose', 'PLAN-0', '--option', 'continue', '--reason', 'Ready.'];
  routed(await refusalOf(() => commitRoutingChoice(root, {}, unwrittenPlan(), { option: 'continue', to: null, reason: 'Ready.', expected: null },
    { actor: { email: 'person@example.test' } })), argv, { code: 'DECISION_NOT_PENDING', route: WRITE_PLANNING });
  routed(await refusalOf(() => decideStory(root, {}, unwrittenPlan(), { option: 'continue', reason: 'Ready.' })), argv,
    { code: 'DECISION_NOT_PENDING', route: WRITE_PLANNING });
});

test('the decision list for a step the Story lacks routes to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  const error = await refusalOf(() => blockingDecisionFacts(root, {}, unwrittenPlan(), { phaseId: 'plannign' }));
  const { envelope } = routed(error, ['decisions', 'PLAN-0', '--phase', 'plannign', '--for-agent', '--json'],
    { code: 'DECISIONS_PHASE_UNKNOWN', route: WRITE_PLANNING });
  assert.doesNotMatch(JSON.stringify(envelope), /--phase plannign --json/u, 'no recovery of a step that does not exist');
});

test('an intent amendment that is not waiting for a decision routes to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  routed(await refusalOf(() => refreshIntentAmendment(root, {}, unwrittenPlan(), 'AMD-001')),
    ['story', 'intent-amendment', 'refresh', '--work-id', 'PLAN-0', 'AMD-001'], { code: 'INTENT_AMENDMENT_NOT_PENDING', route: WRITE_PLANNING });
  routed(await refusalOf(() => decideIntentAmendment(root, {}, unwrittenPlan(), { id: 'AMD-001', status: 'approved' }, { decision: 'approve', reason: 'Ready.' })),
    ['story', 'intent-amendment', 'decide', '--work-id', 'PLAN-0', 'AMD-001', '--decision', 'approve'],
    { code: 'INTENT_AMENDMENT_NOT_PENDING', route: WRITE_PLANNING });
});

test('approving when no step awaits approval routes to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  const error = await refusalOf(() => approvalReviewBinding(root, {}, unwrittenPlan()));
  assert.match(error.message, /has no phase awaiting approval: 'planning' is in_progress\./u);
  routed(error, ['choices', 'begin', 'approve', 'PLAN-0', '--json'], { code: 'APPROVAL_PHASE_NOT_AWAITING', route: WRITE_PLANNING });
});

test('reopening an open Story, cancelling a closed one, and finalizing an unfinished one route to the Story\'s next step', async (t) => {
  const root = await gitRepository(t);
  routed(await refusalOf(() => reopenWorkflow(root, {}, unwrittenPlan(), { target: 'planning', reason: 'Change it.' })),
    ['reopen', 'PLAN-0', '--to', 'planning', '--reason', 'Change it.'], { code: 'STORY_NOT_CLOSED', route: WRITE_PLANNING });
  routed(await refusalOf(() => finalizeStoryDelivery(root, {}, unwrittenPlan())), ['finalize'], { code: 'STORY_NOT_COMPLETE', route: WRITE_PLANNING });
  const closed = unwrittenPlan({ status: 'closed', currentPhase: null, phases: { planning: { status: 'approved', generation: 1 }, implementation: { status: 'approved', generation: 1 } } });
  const error = storyClosedRefusal(closed);
  assert.match(error.message, /is closed, so it has no step in progress to cancel; reopen it when it needs changes after closing\./u);
  routed(error, ['cancel', 'PLAN-0', '--reason', 'Done.'], { code: 'STORY_CLOSED', route: storyRoute(closed) });
});

// While a step's next version is open, writing it is the Story's next step (guide.mjs phaseHandoff, main 95e25ed06):
// the Story's guidance alone said to submit the version before it [design review, 2026-11-16].
test('with a code step\'s version 2 open, a refusal about the Story routes to writing version 2 (/sf-code), never a submission', async (t) => {
  const workflow = unwrittenPlan({ currentPhase: 'implementation', phases: { planning: { status: 'approved', generation: 1 },
    implementation: { status: 'in_progress', generation: 1, generationIntent: { status: 'open', generation: 2 } } } });
  const WRITE_VERSION_2 = { shell: 'singularity-flow prepare implementation', copilot: '/sf-code' };
  const { act } = routed(sourceReviewStepNotCurrent(workflow, workflow.phases.planning, 'stage'),
    ['review-source', 'stage', 'planning', '--report-json', '{}'], { code: 'SOURCE_REVIEW_STEP_NOT_CURRENT', route: WRITE_VERSION_2 });
  assert.equal(act.do.reason, 'Next for this Story: Write version 2 of implementation, then publish it.');
  const root = await gitRepository(t);
  const error = await refusalOf(() => approvalReviewBinding(root, {}, workflow));
  const { envelope } = routed(error, ['choices', 'begin', 'approve', 'PLAN-0', '--json'], { code: 'APPROVAL_PHASE_NOT_AWAITING', route: WRITE_VERSION_2 });
  assert.doesNotMatch(JSON.stringify(envelope.remediationPlan), /singularity-flow submit|\/sf-submit|review-source/u);
  // A decision the Story waits for still comes first.
  const waiting = { ...workflow, pendingDecision: { label: 'implementation', reason: 'limit', by: ['leads'], key: 'k-1' } };
  assert.equal(storyNextDetails(waiting).nextAction.skill, '/sf-decide');
});

test('a refusal that is not about the Story\'s state keeps command help, and the route never fails to build', () => {
  const plain = refusalEnvelope(Object.assign(new Error('Unknown flag --frobnicate.'), { code: 'SOME_USAGE_REFUSAL' }), ['review-source', 'context', '--frobnicate']);
  assert.equal(plain.remediationPlan.steps[0].command, 'singularity-flow help review-source');
  // A Story the guidance cannot read gives no route, so the refusal keeps its ordinary plan rather than failing.
  assert.deepEqual(storyNextDetails({ currentPhase: 'planning' }), {});
});

/** The route the Story's own guidance names, for a Story whose route this file does not spell out. */
function storyRoute(workflow) {
  const { nextAction } = storyNextDetails(workflow);
  assert.ok(nextAction?.command, 'the Story has a next action');
  const { act } = { act: agentAct(refusalEnvelope(Object.assign(new Error('probe'), { code: 'PROBE', details: storyNextDetails(workflow) }), ['status'])) };
  return { shell: nextAction.command, copilot: act.do.copilot };
}
