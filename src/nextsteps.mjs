import { phaseNeedsGeneration, workflowGuide } from './guide.mjs';

function action(timing, skill, command, reason) {
  return { timing, skill, command, reason };
}

function nextPhase(workflow, currentId) {
  const index = workflow.phaseOrder.indexOf(currentId);
  const id = index >= 0 ? workflow.phaseOrder[index + 1] : null;
  return id ? workflow.phases[id] : null;
}

function completionActions(workId, timing = 'now') {
  return [
    action(timing, '/sflow-progress', `singularity-flow progress ${workId}`, 'Review deterministic phase completion and approvals.'),
    action(timing, '/sflow-report', `singularity-flow report ${workId}`, 'Review timing, rework, token usage, and bottlenecks.'),
    action(timing, null, 'singularity-flow gate --terminal', 'Confirm the completed workflow and remote branch satisfy the final gate.')
  ];
}

function afterApprovalActions(workflow, phase) {
  const upcoming = nextPhase(workflow, phase.id);
  if (!upcoming) return completionActions(workflow.workItem.id, 'then');
  return [action('then', '/sflow-phase', `singularity-flow prepare ${upcoming.id}`, `After ${phase.id} approval advances the workflow, generate and publish ${upcoming.label}.`)];
}

export function workflowNextSteps(workflow, { publicationPending = false, prerequisites = [] } = {}) {
  const workId = workflow.workItem.id;
  const phase = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null;
  if (publicationPending) return [
    action('now', null, 'singularity-flow sync', 'Retry the retained commit push; workflow transitions are blocked until publication succeeds.'),
    action('then', '/sflow-nextsteps', `singularity-flow nextsteps ${workId}`, 'Recalculate actions from the synchronized branch state.')
  ];
  if (!phase) return completionActions(workId);

  const immediate = workflowGuide(workflow).nextActions.map((item, index) => action(
    phase.status === 'awaiting_approval' && index > 0 ? 'alternative' : 'now',
    item.skill,
    item.command,
    item.reason
  ));
  if (phase.status === 'awaiting_approval') return [...immediate, ...afterApprovalActions(workflow, phase)];

  const needsGeneration = phaseNeedsGeneration(workflow, phase);
  const actions = [...prerequisites, ...immediate];
  const resolvedPhase = workflow.resolution?.phases?.find((item) => item.id === phase.id);
  if (needsGeneration && workflow.resolution?.inputsMode === 'enforce' && resolvedPhase?.inputs?.length && phase.inputContext?.generation !== phase.generation + 1) {
    actions.unshift(action('now', '/sflow-inputs', `singularity-flow inputs ${phase.id}`, 'Resolve and render every enforced approved phase input before generation.'));
  }
  if (needsGeneration) actions.push(action('then', '/sflow-submit', `singularity-flow submit --phase ${phase.id}`, `After publishing ${phase.id}, run its checks and submit it for approval.`));
  actions.push(
    action('then', '/sflow-approve', `singularity-flow approve ${workId} --fetch`, `After submission, approve ${phase.id} using an approval-capable persona.`),
    action('alternative', '/sflow-reject', `singularity-flow reject ${workId} --fetch --to <phase> --reason <reason>`, `Instead of approval, return ${phase.id} to an allowed earlier phase.`),
    ...afterApprovalActions(workflow, phase)
  );
  return actions;
}

export function nextStepsSnapshot({ initialized = true, branch = null, requestedWorkId = null, workflow = null, publicationPending = false, prerequisites = [] } = {}) {
  if (!initialized) return {
    schemaVersion: 1,
    state: 'not_initialized',
    workId: null,
    currentPhase: null,
    actions: [
      action('now', null, 'singularity-flow init', 'Initialize editable Singularity Flow configuration, templates, personas, and prompts.'),
      action('then', '/sflow-start', 'singularity-flow start <WORK-ID>', 'Commit the initialized configuration, then start Jira or manual intake.')
    ]
  };
  if (!workflow) return {
    schemaVersion: 1,
    state: 'no_active_work_item',
    branch,
    workId: null,
    currentPhase: null,
    actions: requestedWorkId
      ? [
          action('now', '/sflow-resume', `singularity-flow resume ${requestedWorkId} --fetch`, `Fetch and resume the existing ${requestedWorkId} branch.`),
          action('alternative', '/sflow-start', `singularity-flow start ${requestedWorkId}`, `Start ${requestedWorkId} only if it does not already exist.`)
        ]
      : [
          action('now', '/sflow-start', 'singularity-flow start <WORK-ID>', 'Start a Jira or manual work item and choose its workflow template and persona.'),
          action('alternative', '/sflow-resume', 'singularity-flow resume <WORK-ID> --fetch', 'Resume an existing remote work-item branch instead.')
        ]
  };
  return {
    schemaVersion: 1,
    state: publicationPending ? 'publication_pending' : workflow.status,
    branch: workflow.workItem.branch,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    currentPhase: workflow.currentPhase,
    actions: workflowNextSteps(workflow, { publicationPending, prerequisites })
  };
}

export function nextStepsText(snapshot) {
  const lines = [
    snapshot.workId ? `${snapshot.workId} — next actions` : 'Singularity Flow — next actions',
    `State: ${snapshot.state}`,
    snapshot.branch ? `Branch: ${snapshot.branch}` : null,
    snapshot.currentPhase ? `Current phase: ${snapshot.currentPhase}` : null,
    ''
  ].filter((line) => line !== null);
  snapshot.actions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.timing.toUpperCase()}${item.skill ? ` — ${item.skill}` : ''}`);
    lines.push(`   ${item.reason}`);
    lines.push(`   CLI: ${item.command}`);
  });
  return `${lines.join('\n')}\n`;
}
