import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, nowIso, SingularityFlowError } from './util.mjs';

const confirmed = new WeakMap();

function activePhase(workflow) {
  return workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
}

export function sequenceGateMode(workflow, gate) {
  const gates = workflow.resolution?.sequenceGates;
  return (gates?.[gate] ?? gates?.default) === 'soft' ? 'soft' : 'hard';
}

export function phaseNeedsGeneration(workflow, phase) {
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
    commands: [
      `singularity-flow progress ${workId}`,
      `singularity-flow report ${workId}`,
      'singularity-flow gate --terminal'
    ]
  };
  if (phase.status === 'awaiting_approval') return {
    summary: `Review submitted phase '${phase.id}', then approve it or return it for correction.`,
    commands: [
      `singularity-flow approve ${workId} --fetch`,
      `singularity-flow reject ${workId} --fetch --to <phase> --reason <reason>`
    ],
    alternativeSecond: true
  };
  if (phase.status === 'in_progress' && phaseNeedsGeneration(workflow, phase)) return {
    summary: `${phase.generation > 0 ? 'Regenerate' : 'Generate'} and publish phase '${phase.id}' before submission.`,
    commands: [
      `singularity-flow prepare ${phase.id}`,
      `singularity-flow phase publish ${phase.id}`
    ]
  };
  if (phase.status === 'in_progress') return {
    summary: `Submit published phase '${phase.id}' for approval.`,
    commands: [`singularity-flow submit --phase ${phase.id}`]
  };
  return {
    summary: `Continue from the active workflow state for phase '${phase.id}'.`,
    commands: [`singularity-flow nextsteps ${workId}`]
  };
}

function commandLines(commands, alternativeSecond = false) {
  return commands.map((command, index) => `${index === 0 ? 'Run next' : index === 1 && alternativeSecond ? 'Alternatively' : 'Then'}: ${command}`);
}

function sequenceMessage(workflow, gate, action, { requestedPhase = null, reason = null, mode = sequenceGateMode(workflow, gate) } = {}) {
  const phase = activePhase(workflow);
  const target = requestedPhase ?? phase?.id ?? null;
  const current = phase
    ? `phase '${phase.id}' is ${phase.status} at generation ${phase.generation ?? 0}`
    : `workflow '${workflow.workItem.id}' is complete`;
  const guidance = gate === 'publicationPending'
    ? {
        summary: 'Publish the retained local lifecycle commit before any further mutation.',
        commands: ['singularity-flow sync']
      }
    : sequenceGuidance(workflow);
  return [
    `${mode === 'soft' ? 'Soft sequence warning' : 'Out of sequence'} [${gate}]: cannot ${action}${target ? ` for phase '${target}'` : ''}.`,
    `Current state: ${current}.`,
    reason ? `Reason: ${reason}` : null,
    `Gate mode: ${mode}.`,
    `Required next action: ${guidance.summary}`,
    ...commandLines(guidance.commands, guidance.alternativeSecond),
    `See all valid actions: singularity-flow nextsteps ${workflow.workItem.id}`
  ].filter(Boolean).join('\n');
}

export function sequenceError(workflow, action, { gate = 'phaseStatus', requestedPhase = null, reason = null } = {}) {
  return new SingularityFlowError(`${sequenceMessage(workflow, gate, action, { requestedPhase, reason, mode: 'hard' })}\nNo workflow files, commits, or remote state were changed.`, { exitCode: 2 });
}

async function sessionAudit(root) {
  if (!root) return { actor: null, persona: null };
  const file = path.join(root, '.git/singularity-flow/session.json');
  if (!(await exists(file))) return { actor: null, persona: null };
  try {
    const session = JSON.parse(await readFile(file, 'utf8'));
    return { actor: session.actor ?? null, persona: session.persona ?? null };
  } catch {
    return { actor: null, persona: null };
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
    persona: audit.persona
  };
  workflow.sequenceOverrides ??= [];
  workflow.sequenceOverrides.push(record);
  workflow.history ??= [];
  workflow.history.push({
    at,
    actor: audit.actor?.login ?? audit.actor?.email ?? audit.actor?.name ?? 'interactive-user',
    persona: audit.persona,
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
  if (!(await askToContinue(message, gate))) {
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

export async function assertPhaseSequence(root, workflow, action, { requestedPhase = null, allowedStatuses = ['in_progress'] } = {}) {
  let phase = activePhase(workflow);
  if (!phase) {
    const target = requestedPhase ? workflow.phases?.[requestedPhase] : workflow.phases?.[workflow.phaseOrder.at(-1)];
    if (!target) throw sequenceError(workflow, action, { gate: 'completion', requestedPhase, reason: 'No valid phase is available to reopen.' });
    const record = await enforceSequenceGate(root, workflow, 'completion', action, {
      requestedPhase: target.id,
      reason: `The completed workflow must be reopened at '${target.id}' to continue.`
    });
    switchCurrentPhase(workflow, target, record.at);
    phase = target;
  }
  if (requestedPhase && requestedPhase !== phase.id) {
    const requested = workflow.phases?.[requestedPhase];
    if (!requested) throw sequenceError(workflow, action, { gate: 'currentPhase', requestedPhase, reason: `'${requestedPhase}' is not part of this workflow.` });
    const record = await enforceSequenceGate(root, workflow, 'currentPhase', action, {
      requestedPhase,
      reason: `Only the current phase '${phase.id}' may change; '${requestedPhase}' is ${requested.status}.`
    });
    switchCurrentPhase(workflow, requested, record.at);
    phase = requested;
  }
  if (!allowedStatuses.includes(phase.status)) {
    const record = await enforceSequenceGate(root, workflow, 'phaseStatus', action, {
      requestedPhase: requestedPhase ?? phase.id,
      reason: `This action requires status ${allowedStatuses.join(' or ')}, but '${phase.id}' is ${phase.status}.`
    });
    reconcileStatus(workflow, phase, allowedStatuses, record.at);
  }
  return phase;
}
