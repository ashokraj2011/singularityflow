import { SingularityFlowError } from './util.mjs';

function activePhase(workflow) {
  return workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
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
    summary: 'The workflow is complete; no further lifecycle transition is allowed.',
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

export function sequenceError(workflow, action, { requestedPhase = null, reason = null } = {}) {
  const phase = activePhase(workflow);
  const target = requestedPhase ?? phase?.id ?? null;
  const current = phase
    ? `phase '${phase.id}' is ${phase.status} at generation ${phase.generation ?? 0}`
    : `workflow '${workflow.workItem.id}' is complete`;
  const guidance = sequenceGuidance(workflow);
  return new SingularityFlowError([
    `Out of sequence: cannot ${action}${target ? ` for phase '${target}'` : ''}.`,
    `Current state: ${current}.`,
    reason ? `Reason: ${reason}` : null,
    `Required next action: ${guidance.summary}`,
    ...commandLines(guidance.commands, guidance.alternativeSecond),
    `See all valid actions: singularity-flow nextsteps ${workflow.workItem.id}`,
    'No workflow files, commits, or remote state were changed.'
  ].filter(Boolean).join('\n'), { exitCode: 2 });
}

export function assertPhaseSequence(workflow, action, { requestedPhase = null, allowedStatuses = ['in_progress'] } = {}) {
  const phase = activePhase(workflow);
  if (!phase) throw sequenceError(workflow, action, { requestedPhase });
  if (requestedPhase && requestedPhase !== phase.id) {
    throw sequenceError(workflow, action, {
      requestedPhase,
      reason: `Only the current phase '${phase.id}' may change; '${requestedPhase}' is ${workflow.phases?.[requestedPhase]?.status ?? 'not part of this workflow'}.`
    });
  }
  if (!allowedStatuses.includes(phase.status)) {
    throw sequenceError(workflow, action, {
      requestedPhase,
      reason: `This action requires status ${allowedStatuses.join(' or ')}, but '${phase.id}' is ${phase.status}.`
    });
  }
  return phase;
}

export function publicationPendingError(workflow, action) {
  return new SingularityFlowError([
    `Out of sequence: cannot ${action} while publication is pending.`,
    `Current state: Publication is pending because a local lifecycle commit for '${workflow.workItem.id}' has not reached its configured remote.`,
    'Required next action: publish the retained commit before any other workflow mutation.',
    'Run next: singularity-flow sync',
    `Then: singularity-flow nextsteps ${workflow.workItem.id}`,
    'No additional workflow files, commits, or remote state were changed.'
  ].join('\n'), { exitCode: 2 });
}
