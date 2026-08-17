import { phaseNeedsGeneration, workflowGuide } from './guide.mjs';
import { copilotAction } from './copilot-guidance.mjs';

function action(timing, skill, command, reason, metadata = {}) {
  return copilotAction({ timing, skill, command, reason, modelPolicy: 'never', availability: 'available', ...metadata });
}

function nextPhase(workflow, currentId) {
  const index = workflow.phaseOrder.indexOf(currentId);
  const id = index >= 0 ? workflow.phaseOrder[index + 1] : null;
  return id ? workflow.phases[id] : null;
}

function completionActions(workId, timing = 'now') {
  return [
    action(timing, null, 'singularity-flow gate --terminal', 'Confirm the completed workflow and remote branch satisfy the final gate.'),
    action('then', '/sflow-stack', `singularity-flow pr ${workId}`, 'Preview the pull request title, body, base, head, checks, and evidence before publishing anything.'),
    action('then', '/sflow-stack', `singularity-flow pr ${workId} --create`, 'After reviewing the preview, create the governed pull request with explicit confirmation.'),
    action('alternative', '/sflow-progress', `singularity-flow progress ${workId}`, 'Review deterministic phase completion and approvals.'),
    action('alternative', '/sflow-report', `singularity-flow report ${workId}`, 'Review timing, rework, token usage, and bottlenecks.')
  ];
}

function cancellationActions(workflow) {
  return [
    action('now', '/sflow-documents', `singularity-flow documents list ${workflow.workItem.id}`, 'Review the preserved artifacts for this archived Story.'),
    action('alternative', '/sflow-report', `singularity-flow report ${workflow.workItem.id}`, 'Review the lifecycle history, timing, and cancellation record.')
  ];
}

function afterApprovalActions(workflow, phase) {
  const upcoming = nextPhase(workflow, phase.id);
  if (!upcoming) return completionActions(workflow.workItem.id, 'then');
  return [action('then', '/sflow-phase', `singularity-flow prepare ${upcoming.id}`, `After ${phase.id} approval advances the workflow, generate and publish ${upcoming.label}.`)];
}

export function workflowNextSteps(workflow, { publicationPending = false, prerequisites = [], modelMode = { enabled: true } } = {}) {
  const workId = workflow.workItem.id;
  const phase = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null;
  if (publicationPending) return [
    action('now', null, 'singularity-flow sync', 'Retry the retained commit push; workflow transitions are blocked until publication succeeds.'),
    action('then', '/sflow-nextsteps', `singularity-flow nextsteps ${workId}`, 'Recalculate actions from the synchronized branch state.')
  ];
  if (!phase) return workflow.status === 'cancelled' ? cancellationActions(workflow) : completionActions(workId);

  const immediate = workflowGuide(workflow).nextActions.map((item, index) => action(
    phase.status === 'awaiting_approval' && index > 0 ? 'alternative' : 'now',
    item.skill,
    item.command,
    item.reason
  ));
  if (phase.status === 'awaiting_approval') return [...immediate, ...afterApprovalActions(workflow, phase)];

  const needsGeneration = phaseNeedsGeneration(workflow, phase);
  const actions = [...prerequisites.map(copilotAction), ...immediate];
  const generationPolicy = phase.generationPolicy ?? { allowedProducers: ['governed-agent', 'human'], defaultProducer: 'governed-agent' };
  const modelFreeProducer = generationPolicy.allowedProducers?.find((producer) => ['human', 'deterministic', 'external-tool'].includes(producer));
  if (needsGeneration && !modelMode.enabled) {
    if (modelFreeProducer === 'human') actions.unshift(action(
      'now', '/sf-phase', `singularity-flow phase publish ${phase.id} --authored human --from <FILE> --channel manual-import --no-model`,
      `Import and publish ${phase.label} without invoking a model.`,
      { operationId: 'phase', modelPolicy: 'never', route: 'manual' }
    ));
    else if (modelFreeProducer === 'deterministic') actions.unshift(action(
      'now', '/sf-phase', `singularity-flow prepare ${phase.id} --no-model`,
      `Generate ${phase.label} deterministically without invoking a model.`,
      { operationId: 'prepare', modelPolicy: 'never', route: 'deterministic' }
    ));
    else actions.unshift(action(
      'blocked', '/sf-nextsteps', `singularity-flow nextsteps ${workId} --no-model`,
      `${phase.label} has no configured model-free producer.`,
      { operationId: 'phase', modelPolicy: 'required', availability: 'blocked', route: 'none' }
    ));
  }
  const resolvedPhase = workflow.resolution?.phases?.find((item) => item.id === phase.id);
  if (needsGeneration && workflow.resolution?.inputsMode === 'enforce' && resolvedPhase?.inputs?.length && phase.inputContext?.generation !== phase.generation + 1) {
    actions.unshift(action('now', '/sflow-inputs', `singularity-flow inputs ${phase.id}`, 'Resolve and render every enforced approved phase input before generation.'));
  }
  if (needsGeneration) actions.push(action('then', '/sflow-submit', `singularity-flow submit ${phase.id}`, `After publishing ${phase.id}, run its checks and submit it for approval.`));
  actions.push(
    action('then', '/sflow-approve', `singularity-flow approve ${phase.id} --work-id ${workId} --fetch`, `After submission, approve ${phase.id} using an authorized human Git identity; the phase agent is prompt context only.`),
    action('alternative', '/sflow-reject', `singularity-flow reject ${phase.id} --work-id ${workId} --fetch --to <phase> --reason <reason>`, `Instead of approval, return ${phase.id} to an allowed earlier phase.`),
    action('alternative', '/sf-cancel', `singularity-flow cancel ${workId} --reason <reason> --confirm ${workId}`, 'Cancel this Story, preserve its artifacts, and move it to Archived.'),
    ...afterApprovalActions(workflow, phase)
  );
  return actions;
}

export function nextStepsSnapshot({ initialized = true, branch = null, requestedWorkId = null, workflow = null, publicationPending = false, prerequisites = [], modelMode = { enabled: true } } = {}) {
  if (!initialized) return {
    schemaVersion: 1,
    state: 'not_initialized',
    workId: null,
    currentPhase: null,
    actions: [
      action('now', null, 'singularity-flow init', 'Initialize editable Singularity Flow configuration, templates, governed agents, approval authorities, and prompts.'),
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
          action('now', '/sflow-start', 'singularity-flow start <WORK-ID>', 'Start a Jira or manual work item, choose its workflow template, and activate the first phase agent automatically.'),
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
    modelMode: modelMode.enabled ? 'auto' : 'disabled',
    actions: workflowNextSteps(workflow, { publicationPending, prerequisites, modelMode })
  };
}

export function nextStepsText(snapshot) {
  const lines = [
    snapshot.workId ? `${snapshot.workId} — next actions` : 'Singularity Flow — next actions',
    `State: ${snapshot.state}`,
    snapshot.branch ? `Branch: ${snapshot.branch}` : null,
    snapshot.currentPhase ? `Current phase: ${snapshot.currentPhase}` : null,
    snapshot.workId ? 'Automatic next action in Copilot: /sf-next' : null,
    ''
  ].filter((line) => line !== null);
  // The command first, the skill after it. This read the other way round — Copilot's skill name as
  // the headline and the command as its "CLI equivalent" — which told someone reading a terminal
  // that the thing they are using is the secondary way to use the product.
  snapshot.actions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.timing.toUpperCase()} — ${item.command}`);
    lines.push(`   ${item.reason}`);
    if (item.skill) lines.push(`   In Copilot: ${item.skill}`);
  });
  return `${lines.join('\n')}\n`;
}
