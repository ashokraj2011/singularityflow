import { submitRoute } from './submit-route.mjs';
import { isConvergencePhase } from './phase-roles.mjs';
import { convergenceTransitionRoute } from './phase-transition-routes.mjs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, nowIso, SingularityFlowError } from './util.mjs';
import { actionCommandLines, copilotAction } from './copilot-guidance.mjs';
import { action, because, commandResult, noEffects, refused, withCommandResult } from './narration/command-result.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { gitDir } from './git.mjs';
import {
  effectivePhasePublicationProducer, phasePublicationCommand, phasePublicationCommandForProducer,
  phaseUsesDeterministicGeneration
} from './manual-authorship.mjs';
import { operationContext } from './operation-context.mjs';
import { cancelledStoryRefusal, clearApprovalDisposition, clearDecisionState, completionPhaseOf } from './lifecycle-transitions.mjs';
import { phaseNeedsGeneration } from './phase-generation-need.mjs';

export { phaseNeedsGeneration };

const confirmed = new WeakMap();
let activeConfirmationPort = null;

/**
 * The publication route guidance names for the run's model mode: with a model, the configured
 * producer's command; without one, the producer that can publish without a model, in place (the
 * draft `prepare` wrote) and with --no-model, the same route prepublish offers once the draft is
 * ready; null when nothing can publish the phase without a model. Guidance that named the
 * configured route regardless had a person record their own writing as governed-agent/copilot-host.
 * It lives here, not beside the phase contract (manual-authorship.mjs), so the Copilot edit guard
 * that loads that contract on every tool call stays free of the operation context.
 */
export function phasePublicationCommandForMode(phase, {
  modelEnabled = operationContext()?.modelMode?.enabled !== false, executable = 'singularity-flow'
} = {}) {
  if (modelEnabled) return phasePublicationCommand(phase, executable);
  const producer = effectivePhasePublicationProducer(phase, { modelEnabled: false });
  return producer === 'governed-agent' ? null
    : phasePublicationCommandForProducer(phase, producer, { executable, noModel: true });
}

function activePhase(workflow) {
  return workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
}

export function sequenceGateMode(workflow, gate) {
  const gates = workflow.resolution?.sequenceGates;
  return (gates?.[gate] ?? gates?.default) === 'soft' ? 'soft' : 'hard';
}

/**
 * A step sent back for rework (an open change request, a rework revalidation that needs a new
 * generation, or an unrevalidated intent amendment). Its published bytes may be unchanged, so the
 * successor starts with `prepare`, not a code rollover, which needs changed bytes.
 */
export function phaseExplicitlyReopened(workflow, phase) {
  return (workflow?.changeRequests ?? []).some((request) => request.status === 'open' && request.targetPhase === phase?.id)
    || Boolean(phase?.reworkRevalidation && phaseNeedsGeneration(workflow, phase))
    // A reviewed skill amendment reopens its affected steps the same way: the consumed intent
    // belongs to the generation before the amendment, so the next one is prepared, not rolled over.
    || Boolean(phase?.skillAmendmentRevalidation?.state === 'affected' && phaseNeedsGeneration(workflow, phase))
    || Boolean(phase?.intentAmendmentRevalidation && !phase.intentAmendmentRevalidation.revalidatedAt);
}


export function sequenceGuidance(workflow) {
  const workId = workflow.workItem.id;
  const phase = activePhase(workflow);
  const pending = workflow.pendingDecision;
  if (pending) return {
    summary: `Choose what happens next for '${pending.label}'${pending.reason === 'limit' ? '; its rounds are used' : ''}. Members of ${pending.by.join(', ')} decide.`,
    actions: [
      copilotAction({ skill: '/sflow-decide', command: `singularity-flow decision show ${workId}` }),
      copilotAction({ skill: '/sflow-decide', command: `singularity-flow decision choose ${workId} --option <option> --reason <reason> --expected ${pending.key}` })
    ]
  };
  if (!phase) return {
    summary: 'The Story is closed; no further lifecycle transition is normally allowed.',
    actions: [
      copilotAction({ skill: '/sflow-progress', command: `singularity-flow progress ${workId}` }),
      copilotAction({ skill: '/sflow-report', command: `singularity-flow report ${workId}` }),
      copilotAction({ command: 'singularity-flow gate --terminal' })
    ]
  };
  if (phase.status === 'awaiting_approval') return {
    summary: `Review submitted phase '${phase.id}', then approve it or return it for correction.`,
    actions: [
      copilotAction({ skill: '/sflow-approve', command: `singularity-flow approve ${phase.id} --work-id ${workId} --fetch` }),
      copilotAction({ skill: '/sflow-reject', command: `singularity-flow reject ${phase.id} --work-id ${workId} --fetch --to <phase> --reason <reason>` })
    ],
    alternativeSecond: true
  };
  if (phase.status === 'in_progress' && phaseNeedsGeneration(workflow, phase)) {
    const convergence = isConvergencePhase(phase) && phaseUsesDeterministicGeneration(phase);
    // The publication named here follows the run's model mode, as the planner's does (nextsteps.mjs).
    const publication = convergence ? null : phasePublicationCommandForMode(phase);
    return {
      summary: convergence
        ? `Prepare deterministic phase '${phase.id}', then follow its returned human-review or publication action.`
        : `${phase.generation > 0 ? 'Regenerate' : 'Generate'} and publish phase '${phase.id}' before submission.`,
      actions: [
        copilotAction({ skill: generationSkillForPhase(phase, workflow), command: `singularity-flow prepare ${phase.id}` }),
        ...(publication ? [copilotAction({ skill: generationSkillForPhase(phase, workflow), command: publication })] : [])
      ]
    };
  }
  const convergenceRoute = convergenceTransitionRoute(workflow, phase, { needsGeneration: phaseNeedsGeneration(workflow, phase) });
  if (convergenceRoute) return { summary: convergenceRoute.reason, actions: [copilotAction(convergenceRoute)] };
  if (phase.status === 'in_progress') return {
    summary: phase.approvalPolicy?.mode === 'none'
      ? `Submit published phase '${phase.id}' to run its checks, complete it, and advance.`
      : `Submit published phase '${phase.id}' for approval.`,
    actions: [copilotAction(submitRoute(workflow, phase))]
  };
  return {
    summary: `Continue from the active workflow state for phase '${phase.id}'.`,
    actions: [copilotAction({ skill: '/sflow-nextsteps', command: `singularity-flow nextsteps ${workId}` })]
  };
}

function commandLines(actions, alternativeSecond = false) {
  return actions.flatMap((action, index) => actionCommandLines(
    action,
    index === 0 ? 'Run next' : index === 1 && alternativeSecond ? 'Alternative' : 'Then'
  ));
}

/** The way on a gate names: publish a retained commit first (or set aside one the remote moved past), or the Story's own next step. */
function gateGuidance(workflow, gate, { setAside = null } = {}) {
  if (gate !== 'publicationPending') return sequenceGuidance(workflow);
  return setAside
    ? { summary: 'The remote moved past the retained local lifecycle commit, so sync cannot send it: preview setting it aside.',
        actions: [copilotAction({ command: setAside })] }
    : { summary: 'Publish the retained local lifecycle commit before any further mutation.',
        actions: [copilotAction({ command: 'singularity-flow sync' })] };
}

function sequenceMessage(workflow, gate, action, { requestedPhase = null, reason = null, mode = sequenceGateMode(workflow, gate), guidance: withGuidance = true, setAside = null } = {}) {
  const phase = activePhase(workflow);
  const target = requestedPhase ?? phase?.id ?? null;
  const current = phase
    ? `phase '${phase.id}' is ${phase.status} at generation ${phase.generation ?? 0}`
    : `workflow '${workflow.workItem.id}' is complete`;
  const guidance = gateGuidance(workflow, gate, { setAside });
  // An approver whose clone is behind saw only the author's prepare and publish (2026-10-28): a step
  // in progress here may have been submitted from another clone.
  const approving = action === 'approve' && gate === 'phaseStatus' ? workflow.phases?.[target] : null;
  const behind = approving?.status === 'in_progress'
    ? `If ${approving.id} was submitted from another clone, bring that in first: singularity-flow refresh-branch, or approve with --fetch (singularity-flow approve ${approving.id} --work-id ${workflow.workItem.id} --fetch).`
    : null;
  return [
    `${mode === 'soft' ? 'Soft sequence warning' : 'Out of sequence'} [${gate}]: cannot ${action}${target ? ` for phase '${target}'` : ''}.`,
    `Current state: ${current}.`,
    reason ? `Reason: ${reason}` : null,
    behind,
    `Gate mode: ${mode}.`,
    // Hard refusals carry a narrated result whose NEXT owns the guidance, so repeating it here would
    // print the same advice twice in two different vocabularies. The soft-warning path has no
    // narrated result yet and still needs it.
    ...(withGuidance ? [
      `Required next action: ${guidance.summary}`,
      ...commandLines(guidance.actions, guidance.alternativeSecond),
      ...actionCommandLines({ command: `singularity-flow nextsteps ${workflow.workItem.id}`, skill: `/sf-nextsteps` }, 'See all valid actions')
    ] : [])
  ].filter(Boolean).join('\n');
}

/**
 * Which cataloged reason a failed gate corresponds to.
 *
 * Gates are the kernel's vocabulary; reason codes are the narration plane's. Mapping them here
 * keeps handlers out of the business of explaining themselves in prose.
 */
const GATE_REASONS = Object.freeze({
  publicationPending: 'publication.pending',
  freshGeneration: 'generation.not-published',
  generationCommit: 'generation.not-published',
  remoteGeneration: 'generation.not-published',
  documentPhase: 'artifact.missing'
});

/**
 * The way forward from a failed gate, taken from the planner that already knows it.
 *
 * `sequenceGuidance` is this module's deterministic answer to "what should happen next", and it is
 * what the prose used to print. Reusing it keeps one opinion about valid continuation instead of a
 * second, quietly diverging list — and it stays phase-aware, which a hand-rolled gate map was not.
 *
 * Supplied at construction because `commandResult` refuses to build a result with no continuation:
 * a refusal that stops someone without telling them how to proceed is not constructible.
 */
function gateRemediation(workflow, gate, options) {
  const guidance = gateGuidance(workflow, gate, options);
  const actions = guidance.actions.filter((entry) => entry.command);
  if (!actions.length) {
    return [action({
      id: 'list-valid-actions',
      label: 'See every action this Story can take right now',
      command: `singularity-flow nextsteps ${workflow.workItem.id}`,
      rank: 'NOW',
      kind: 'remediation'
    })];
  }
  return actions.map((entry, index) => action({
    id: `sequence-step-${index + 1}`,
    label: index === 0 ? guidance.summary : `Then: ${entry.command}`,
    command: entry.command,
    skill: entry.skill,
    rank: index === 0 ? 'NOW' : 'SOON',
    kind: 'remediation'
  }));
}

export function sequenceError(workflow, action, { gate = 'phaseStatus', requestedPhase = null, reason = null, setAside = null } = {}) {
  // The reassurance sentence used to be concatenated onto this message by hand. It is now derived
  // from `effects` at the renderer, so it cannot survive a future change that makes this path touch
  // something. The prose body stays for now: converting every refusal's detail into catalog slots is
  // the migration, not this change.
  const error = new SingularityFlowError(
    sequenceMessage(workflow, gate, action, { requestedPhase, reason, mode: 'hard', guidance: false, setAside }), { exitCode: 2 });
  const phase = requestedPhase ?? workflow.currentPhase ?? null;
  return withCommandResult(error, commandResult({
    operation: { id: action.replace(/\s+/g, '-'), classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: refused('sequence.refused', { action, phase, gate }),
    // A sequence gate refuses before the unit of work opens, so nothing has moved. Declared, not
    // asserted in prose.
    effects: noEffects(),
    why: [because(GATE_REASONS[gate] ?? 'sequence.gate-failed', 'sequence', {
      ref: `gate:${gate}`,
      slots: { gate, phase, action }
    })],
    next: gateRemediation(workflow, gate, { setAside })
  }));
}

async function sessionAudit(root) {
  if (!root) return { actor: null, agent: null };
  // In a linked worktree `.git` is a pointer file. Resolve the actual per-worktree Git directory.
  const file = path.join(gitDir(root), 'singularity-flow/session.json');
  if (!(await exists(file))) return { actor: null, agent: null };
  try {
    const session = JSON.parse(await readFile(file, 'utf8'));
    return { actor: session.actor ?? null, agent: session.agent ?? null };
  } catch {
    return { actor: null, agent: null };
  }
}

function confirmationKey(gate, requestedPhase, reason) {
  return `${gate}\0${requestedPhase ?? ''}\0${reason ?? ''}`;
}

/**
 * The refusal when a soft gate cannot be confirmed here: no terminal to ask in, or an override that
 * does not name this gate. It says exactly what to add, so a script or an editor can continue.
 */
export function sequenceConfirmationRequired(message, gate, next = null) {
  return new SingularityFlowError(
    `${message}\nTo continue anyway, run it again in an interactive terminal, or add --confirm-override continue:${gate} (once for each gate it reports). The override is recorded. Nothing was changed.`,
    { exitCode: 2, code: 'SEQUENCE_CONFIRMATION_REQUIRED', details: {
      gate, confirmOverride: `continue:${gate}`,
      // The Story's next step, the alternative to overriding: recovery routes it before the override.
      ...(next ? { nextAction: next } : {})
    } }
  );
}

async function askToContinue(message, gate, next = null) {
  const testConfirmation = process.env.NODE_ENV === 'test' ? process.env.SINGULARITY_FLOW_TEST_SEQUENCE_CONFIRM : null;
  if (testConfirmation != null) {
    const accepted = testConfirmation.split(',').map((value) => value.trim()).filter(Boolean);
    return accepted.includes('all') || accepted.includes(gate);
  }
  if (!input.isTTY || !output.isTTY) throw sequenceConfirmationRequired(message, gate, next);
  console.warn(`\n${message}`);
  const io = readline.createInterface({ input, output });
  try {
    const answer = await io.question('\nDo you want to continue anyway? Type continue to proceed: ');
    return answer.trim().toLowerCase() === 'continue';
  } finally {
    io.close();
  }
}

/** Port used by terminal and editor confirmation adapters. */
export async function confirmOverride({ message, gate, next = null }, confirmationPort = activeConfirmationPort ?? askToContinue) {
  return confirmationPort(message, gate, next);
}

/** Scope one surface adapter to one command; it can never leak into the next invocation. */
export async function withConfirmationPort(confirmationPort, operation) {
  const previous = activeConfirmationPort;
  activeConfirmationPort = confirmationPort;
  try { return await operation(); }
  finally { activeConfirmationPort = previous; }
}

async function recordOverride(root, workflow, gate, action, { requestedPhase, reason, before }) {
  const at = nowIso();
  const audit = await sessionAudit(root);
  const record = {
    gate,
    mode: 'soft',
    action,
    requestedPhase: requestedPhase ?? null,
    reason: reason ?? null,
    before,
    at,
    actor: audit.actor,
    agent: audit.agent
  };
  workflow.sequenceOverrides ??= [];
  workflow.sequenceOverrides.push(record);
  workflow.history ??= [];
  workflow.history.push({
    at,
    actor: audit.actor?.login ?? audit.actor?.email ?? audit.actor?.name ?? 'interactive-user',
    agent: audit.agent,
    event: 'sequence_gate_overridden',
    phase: requestedPhase ?? workflow.currentPhase ?? null,
    detail: `${gate}: ${action}${reason ? ` — ${reason}` : ''}`
  });
  return record;
}

export async function enforceSequenceGate(root, workflow, gate, action, { requestedPhase = null, reason = null, setAside = null } = {}) {
  const mode = sequenceGateMode(workflow, gate);
  if (mode === 'hard') throw sequenceError(workflow, action, { gate, requestedPhase, reason, setAside });
  const key = confirmationKey(gate, requestedPhase, reason);
  const accepted = confirmed.get(workflow) ?? new Map();
  if (accepted.has(key)) return accepted.get(key);
  // The Story's own next step is unrelated to adding a document outside its upload window, so that
  // gate's warning leaves it out; the other gates' next steps are the alternative to continuing.
  const message = sequenceMessage(workflow, gate, action, { requestedPhase, reason, mode, guidance: gate !== 'documentPhase', setAside });
  const next = gate === 'documentPhase' ? null : gateGuidance(workflow, gate, { setAside }).actions?.[0]?.command ?? null;
  if (!(await confirmOverride({ message, gate, next }))) {
    throw new SingularityFlowError(`${message}\nSoft gate was not confirmed. Nothing was changed.`, { exitCode: 2 });
  }
  const phase = activePhase(workflow);
  const record = await recordOverride(root, workflow, gate, action, {
    requestedPhase,
    reason,
    before: {
      workflowStatus: workflow.status,
      currentPhase: workflow.currentPhase,
      phaseStatus: phase?.status ?? null,
      generation: phase?.generation ?? null
    }
  });
  accepted.set(key, record);
  confirmed.set(workflow, accepted);
  console.warn(`Continuing after confirmed soft gate '${gate}'. The override will be audited.`);
  return record;
}

function switchCurrentPhase(workflow, phase, at) {
  const targetIndex = workflow.phaseOrder.indexOf(phase.id);
  for (let index = 0; index < workflow.phaseOrder.length; index += 1) {
    const candidate = workflow.phases[workflow.phaseOrder[index]];
    if (candidate.id === phase.id) {
      candidate.status = 'in_progress';
      candidate.startedAt ??= at;
      candidate.submittedAt = null;
      candidate.approvedAt = null;
      candidate.approvedBy = null;
      clearDecisionState(candidate);
      clearApprovalDisposition(candidate);
      continue;
    }
    if (['in_progress', 'awaiting_approval'].includes(candidate.status) || index > targetIndex) {
      candidate.status = 'not_started';
      candidate.submittedAt = null;
      candidate.approvedAt = null;
      candidate.approvedBy = null;
      clearDecisionState(candidate);
      clearApprovalDisposition(candidate);
    }
    if (index >= targetIndex) candidate.approvals?.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = at; });
  }
  // A deliberate jump supersedes any question that was waiting for a person.
  delete workflow.pendingDecision;
  workflow.currentPhase = phase.id;
  workflow.status = 'in_progress';
}

function reconcileStatus(workflow, phase, allowedStatuses, at) {
  const desired = allowedStatuses[0];
  if (desired === 'in_progress') {
    phase.status = 'in_progress';
    phase.submittedAt = null;
    phase.approvals?.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = at; });
    clearApprovalDisposition(phase);
  } else if (desired === 'awaiting_approval') {
    phase.status = 'awaiting_approval';
    phase.submittedAt ??= at;
    clearApprovalDisposition(phase);
  }
  workflow.currentPhase = phase.id;
  workflow.status = 'in_progress';
}

/** Pure decision: it inspects lifecycle state but never prompts or mutates it. */
export function evaluateSequence(workflow, {
  requestedPhase = null,
  allowedStatuses = ['in_progress']
} = {}) {
  const phase = activePhase(workflow);
  // A Story waiting for a person moves only by that person's choice. The approved phase before the
  // decision must not be reconciled back into progress by a soft status gate.
  if (workflow.pendingDecision) {
    return {
      allowed: false, gate: 'decision', targetPhase: workflow.pendingDecision.after, invalid: true,
      reason: `The Story is waiting for a decision: '${workflow.pendingDecision.label}'. Choose with singularity-flow decision choose ${workflow.workItem.id}.`
    };
  }
  if (workflow.status === 'cancelled') {
    return { allowed: false, gate: 'completion', targetPhase: null, invalid: true, reason: cancelledStoryRefusal(workflow).message };
  }
  if (!phase) {
    const target = requestedPhase ? workflow.phases?.[requestedPhase] : completionPhaseOf(workflow);
    return target
      ? { allowed: false, gate: 'completion', targetPhase: target.id, effect: 'switch', reason: `The completed workflow must be reopened at '${target.id}' to continue.` }
      : { allowed: false, gate: 'completion', targetPhase: requestedPhase, invalid: true, reason: 'No valid phase is available to reopen.' };
  }
  if (requestedPhase && requestedPhase !== phase.id) {
    const requested = workflow.phases?.[requestedPhase];
    return requested
      ? { allowed: false, gate: 'currentPhase', targetPhase: requestedPhase, effect: 'switch', reason: `Only the current phase '${phase.id}' may change; '${requestedPhase}' is ${requested.status}.` }
      : { allowed: false, gate: 'currentPhase', targetPhase: requestedPhase, invalid: true, reason: `'${requestedPhase}' is not part of this workflow.` };
  }
  if (!allowedStatuses.includes(phase.status)) {
    return {
      allowed: false,
      gate: 'phaseStatus',
      targetPhase: phase.id,
      effect: 'status',
      allowedStatuses: [...allowedStatuses],
      reason: `This action requires status ${allowedStatuses.join(' or ')}, but '${phase.id}' is ${phase.status}.`
    };
  }
  return { allowed: true, phaseId: phase.id };
}

/** Pure reducer: returns a new aggregate after an already-confirmed decision. */
export function applySequenceDecision(workflow, decision, at) {
  const next = structuredClone(workflow);
  const phase = next.phases?.[decision.targetPhase];
  if (!phase) throw sequenceError(next, 'apply a sequence decision', {
    gate: decision.gate,
    requestedPhase: decision.targetPhase,
    reason: decision.reason
  });
  if (decision.effect === 'switch') switchCurrentPhase(next, phase, at);
  else if (decision.effect === 'status') reconcileStatus(next, phase, decision.allowedStatuses, at);
  return next;
}

export async function assertPhaseSequence(root, workflow, action, { requestedPhase = null, allowedStatuses = ['in_progress'] } = {}) {
  if (action === 'approve' && requestedPhase && workflow.phases?.[requestedPhase]?.status === 'approved') {
    const phase = workflow.phases[requestedPhase];
    const error = new SingularityFlowError(`Phase '${requestedPhase}' was already approved by ${phase.approvedBy ?? 'the recorded authority'} at ${phase.approvedAt ?? 'the retained decision'}. End this approval turn; inspect the next action in a new turn.`, {
      code: 'PHASE_ALREADY_APPROVED', details: { phase: requestedPhase, approvedBy: phase.approvedBy,
        approvedAt: phase.approvedAt, currentPhase: workflow.currentPhase, turnBoundary: 'end' }
    });
    throw withCommandResult(error, commandResult({ operation: { id: 'approve', classification: 'mutation' },
      subject: { kind: 'story', id: workflow.workItem.id }, outcome: refused('approve.refused', { phase: requestedPhase }),
      effects: noEffects(), next: [actionForApprovalHandoff()], data: { turnBoundary: 'end',
        previousDecision: error.details } }));
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const decision = evaluateSequence(workflow, { requestedPhase, allowedStatuses });
    if (decision.allowed) return workflow.phases[decision.phaseId];
    if (decision.invalid) throw sequenceError(workflow, action, {
      gate: decision.gate,
      requestedPhase: decision.targetPhase,
      reason: decision.reason
    });
    const record = await enforceSequenceGate(root, workflow, decision.gate, action, {
      requestedPhase: decision.targetPhase,
      reason: decision.reason
    });
    const next = applySequenceDecision(workflow, decision, record.at);
    Object.keys(workflow).forEach((key) => delete workflow[key]);
    Object.assign(workflow, next);
  }
  throw sequenceError(workflow, action, {
    gate: 'phaseStatus', requestedPhase, reason: 'Sequence reconciliation did not reach a stable state.'
  });
}

function actionForApprovalHandoff() {
  return action({ id: 'inspect-next-turn', label: 'End this turn; inspect the next action in a new turn',
    command: 'singularity-flow nextsteps --json', kind: 'informational' });
}
