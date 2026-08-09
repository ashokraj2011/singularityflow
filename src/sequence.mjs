import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, nowIso, SingularityFlowError } from './util.mjs';
import { actionCommandLines, copilotAction } from './copilot-guidance.mjs';
import { action, because, commandResult, noEffects, refused } from './narration/command-result.mjs';
import { withCommandResult } from './narration/emit.mjs';

const confirmed = new WeakMap();
let activeConfirmationPort = null;

function activePhase(workflow) {
  return workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
}

export function sequenceGateMode(workflow, gate) {
  const gates = workflow.resolution?.sequenceGates;
  return (gates?.[gate] ?? gates?.default) === 'soft' ? 'soft' : 'hard';
}

export function phaseNeedsGeneration(workflow, phase) {
  if (phase?.generationPolicy?.requirement === 'none') return false;
  if (!phase || phase.generation < 1) return true;
  if (!phase.rejectedAt) return false;
  return !(workflow.history ?? []).some((event) =>
    event.phase === phase.id && event.event === 'phase_generated' && event.at > phase.rejectedAt);
}

export function sequenceGuidance(workflow) {
  const workId = workflow.workItem.id;
  const phase = activePhase(workflow);
  if (!phase) return {
    summary: 'The workflow is complete; no further lifecycle transition is normally allowed.',
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
  if (phase.status === 'in_progress' && phaseNeedsGeneration(workflow, phase)) return {
    summary: `${phase.generation > 0 ? 'Regenerate' : 'Generate'} and publish phase '${phase.id}' before submission.`,
    actions: [
      copilotAction({ skill: '/sflow-phase', command: `singularity-flow prepare ${phase.id}` }),
      copilotAction({ skill: '/sflow-phase', command: `singularity-flow phase publish ${phase.id}` })
    ]
  };
  if (phase.status === 'in_progress') return {
    summary: `Submit published phase '${phase.id}' for approval.`,
    actions: [copilotAction({ skill: '/sflow-submit', command: `singularity-flow submit ${phase.id}` })]
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

function sequenceMessage(workflow, gate, action, { requestedPhase = null, reason = null, mode = sequenceGateMode(workflow, gate), guidance: withGuidance = true } = {}) {
  const phase = activePhase(workflow);
  const target = requestedPhase ?? phase?.id ?? null;
  const current = phase
    ? `phase '${phase.id}' is ${phase.status} at generation ${phase.generation ?? 0}`
    : `workflow '${workflow.workItem.id}' is complete`;
  const guidance = gate === 'publicationPending'
    ? {
        summary: 'Publish the retained local lifecycle commit before any further mutation.',
        actions: [copilotAction({ command: 'singularity-flow sync' })]
      }
    : sequenceGuidance(workflow);
  return [
    `${mode === 'soft' ? 'Soft sequence warning' : 'Out of sequence'} [${gate}]: cannot ${action}${target ? ` for phase '${target}'` : ''}.`,
    `Current state: ${current}.`,
    reason ? `Reason: ${reason}` : null,
    `Gate mode: ${mode}.`,
    // Hard refusals carry a narrated result whose NEXT owns the guidance, so repeating it here would
    // print the same advice twice in two different vocabularies. The soft-warning path has no
    // narrated result yet and still needs it.
    ...(withGuidance ? [
      `Required next action: ${guidance.summary}`,
      ...commandLines(guidance.actions, guidance.alternativeSecond),
      `See all valid actions in Copilot: /sf-nextsteps ${workflow.workItem.id}`,
      `CLI equivalent: singularity-flow nextsteps ${workflow.workItem.id}`
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
function gateRemediation(workflow, gate) {
  const guidance = gate === 'publicationPending'
    ? {
        summary: 'Publish the retained local lifecycle commit before any further mutation.',
        actions: [copilotAction({ command: 'singularity-flow sync' })]
      }
    : sequenceGuidance(workflow);
  const commands = guidance.actions.map((entry) => entry.command).filter(Boolean);
  if (!commands.length) {
    return [action({
      id: 'list-valid-actions',
      label: 'See every action this Story can take right now',
      command: `singularity-flow nextsteps ${workflow.workItem.id}`,
      rank: 'NOW',
      kind: 'remediation'
    })];
  }
  return commands.map((command, index) => action({
    id: `sequence-step-${index + 1}`,
    label: index === 0 ? guidance.summary : `Then: ${command}`,
    command,
    rank: index === 0 ? 'NOW' : 'SOON',
    kind: 'remediation'
  }));
}

export function sequenceError(workflow, action, { gate = 'phaseStatus', requestedPhase = null, reason = null } = {}) {
  // The reassurance sentence used to be concatenated onto this message by hand. It is now derived
  // from `effects` at the renderer, so it cannot survive a future change that makes this path touch
  // something. The prose body stays for now: converting every refusal's detail into catalog slots is
  // the migration, not this change.
  const error = new SingularityFlowError(
    sequenceMessage(workflow, gate, action, { requestedPhase, reason, mode: 'hard', guidance: false }), { exitCode: 2 });
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
    next: gateRemediation(workflow, gate)
  }));
}

async function sessionAudit(root) {
  if (!root) return { actor: null, agent: null };
  const file = path.join(root, '.git/singularity-flow/session.json');
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

async function askToContinue(message, gate) {
  const testConfirmation = process.env.NODE_ENV === 'test' ? process.env.SINGULARITY_FLOW_TEST_SEQUENCE_CONFIRM : null;
  if (testConfirmation != null) {
    const accepted = testConfirmation.split(',').map((value) => value.trim()).filter(Boolean);
    return accepted.includes('all') || accepted.includes(gate);
  }
  if (!input.isTTY || !output.isTTY) {
    throw new SingularityFlowError(`${message}\nSoft gate confirmation requires an interactive terminal. Nothing was changed.`, { exitCode: 2 });
  }
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
export async function confirmOverride({ message, gate }, confirmationPort = activeConfirmationPort ?? askToContinue) {
  return confirmationPort(message, gate);
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

export async function enforceSequenceGate(root, workflow, gate, action, { requestedPhase = null, reason = null } = {}) {
  const mode = sequenceGateMode(workflow, gate);
  if (mode === 'hard') throw sequenceError(workflow, action, { gate, requestedPhase, reason });
  const key = confirmationKey(gate, requestedPhase, reason);
  const accepted = confirmed.get(workflow) ?? new Map();
  if (accepted.has(key)) return accepted.get(key);
  const message = sequenceMessage(workflow, gate, action, { requestedPhase, reason, mode });
  if (!(await confirmOverride({ message, gate }))) {
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
      continue;
    }
    if (['in_progress', 'awaiting_approval'].includes(candidate.status) || index > targetIndex) {
      candidate.status = 'not_started';
      candidate.submittedAt = null;
      candidate.approvedAt = null;
      candidate.approvedBy = null;
    }
    if (index >= targetIndex) candidate.approvals?.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = at; });
  }
  workflow.currentPhase = phase.id;
  workflow.status = 'in_progress';
}

function reconcileStatus(workflow, phase, allowedStatuses, at) {
  const desired = allowedStatuses[0];
  if (desired === 'in_progress') {
    phase.status = 'in_progress';
    phase.submittedAt = null;
    phase.approvals?.forEach((approval) => { if (!approval.invalidatedAt) approval.invalidatedAt = at; });
  } else if (desired === 'awaiting_approval') {
    phase.status = 'awaiting_approval';
    phase.submittedAt ??= at;
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
  if (!phase) {
    const target = requestedPhase ? workflow.phases?.[requestedPhase] : workflow.phases?.[workflow.phaseOrder.at(-1)];
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
