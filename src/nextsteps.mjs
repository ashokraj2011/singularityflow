/** Native next-step observations and presentation. Ordered rules are owned by the kernel. */
import { phaseNeedsGeneration } from './kernel/phase-policy.mjs';
import { workflowNextPlan } from './kernel/next-plan.mjs';
import { continuationActionPresentation } from './phase-transition-routes.mjs';
import { phaseAuthoringProgress } from './phase-authoring-progress.mjs';
import { phasePublicationCommandForMode } from './sequence.mjs';
import { copilotAction, copilotSkillForCommand } from './copilot-guidance.mjs';
import { commandRouteLines, safeCommandGuidance } from './safe-command-guidance.mjs';
import { generationSkillForPhase, applicationReviewOffer } from './code-delivery-policy.mjs';
import { phasePublicationCommand, phasePublicationCommandForProducer } from './phase-publication-guidance.mjs';
import { modelOffCause, operationContext } from './operation-context.mjs';
import { decisionSubmitArguments, describeOutcome, describeWhen, decisionReads, decisionAfter, upcomingDecision } from './workflow-decisions.mjs';
import { nextPhaseAfterSkillAmendment } from './kernel/lifecycle-transitions.mjs';
import { applicabilityStatus } from './evidence/applicability.mjs';
import { contextBoundaryPresentation, formatContextBoundaryHandoff, pendingContextBoundary } from './context-policy.mjs';
import { OPEN_UPSTREAM_ISSUE_STATUSES, decisionHeadline, upstreamIssueStates } from './upstream-routes.mjs';
import { sheetRoute } from './step-sheet-route.mjs';

function action(timing, skill, command, reason, metadata = {}) {
  const candidate = copilotAction({
    timing, skill, command, reason, modelPolicy: 'never', availability: 'available', ...metadata
  });
  // The planner's skill is kept when the pair is safe to show; otherwise the command's own route,
  // as plannedAction does for results. A mismatched skill must not hide a safe Shell command.
  const guidance = safeCommandGuidance(candidate) ?? safeCommandGuidance({ command });
  return guidance ? Object.freeze({ ...candidate, ...guidance }) : candidate;
}

/** The run's model mode, so a planner called without one never assumes a model is available. */
function ambientModelMode() {
  return operationContext()?.modelMode ?? { enabled: true };
}

/**
 * The applicability decisions an ending still needs, when completing this phase would end the
 * Story: the final evaluation refuses the ending until each one is recorded.
 */
export function endingApplicabilityDecisions(workflow, phase) {
  const ahead = upcomingDecision(workflow, phase);
  let endpoint;
  if (ahead) {
    if (ahead.outcome?.kind !== 'end') return [];
    endpoint = (workflow.resolution?.obligationGraph?.endpoints ?? []).find((entry) =>
      entry.decision === ahead.decision.id && entry.route === ahead.outcome.route);
  } else if (nextPhaseAfterSkillAmendment(workflow, phase)) {
    return [];
  }
  return applicabilityStatus(workflow, endpoint).filter((entry) => !entry.satisfied).map((entry) => ({
    responsibility: entry.responsibility, authority: entry.authority,
    command: `singularity-flow decision applicability ${workflow.workItem.id} --responsibility ${entry.responsibility} --reason <reason>`,
    message: `This Story ends without ${entry.responsibility}; someone in ${entry.authority} records why it does not apply before it can finish.`
  }));
}

function decisionHold(workflow, phase, pendingDecisions) {
  if (pendingDecisions !== undefined) return pendingDecisions?.count ? pendingDecisions : null;
  const order = workflow.phaseOrder ?? [];
  const ends = order.indexOf(phase.id) >= 0 && order.slice(order.indexOf(phase.id) + 1).every((id) => workflow.phases?.[id]?.status === 'skipped');
  const open = ends ? upstreamIssueStates(workflow).filter((state) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(state.status)).length : 0;
  return open ? { count: open, headline: decisionHeadline(workflow, phase.id, open), command: `singularity-flow decisions ${workflow.workItem.id}` } : null;
}


/** Translate host observations once. Commands and prompt wording do not cross the engine port. */
export function nextStepObservations(workflow, {
  publicationPending = false, recovery = null, prerequisites = [], modelMode = ambientModelMode(),
  stepActionHold = null, sourceReviewEvidence = null, authoringProgress = null, repositoryHost = null,
  pendingDecisions = undefined, visualCoverageHold = null, mcpHold = null, approvalCheck = null, sheet = null
} = {}) {
  const phase = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null;
  const priority = { publicationPending: Boolean(publicationPending), recoveryRequired: Boolean(recovery?.requiresRecovery),
    recoveryPhase: recovery?.phaseId ?? null, modelEnabled: Boolean(modelMode.enabled),
    manualPullRequest: new Set(['gitlab', 'bitbucket', 'azure-devops', 'local']).has(repositoryHost?.provider) };
  if (priority.publicationPending || priority.recoveryRequired || !phase || workflow.pendingDecision) {
    return { facts: priority, presentation: { held: null, approvalGroups: [], applicability: [] } };
  }
  const held = phase ? decisionHold(workflow, phase, pendingDecisions) : null;
  const groups = new Map();
  for (const hold of (approvalCheck?.ready === false ? approvalCheck.holds ?? [] : []).filter(hold => hold.owner !== 'you-decide')) {
    const command = hold.action?.command ?? `singularity-flow phase show ${phase?.id} --json`;
    groups.set(command, [...(groups.get(command) ?? []), hold]);
  }
  const applicability = phase ? endingApplicabilityDecisions(workflow, phase) : [];
  return {
    facts: {
      ...priority,
      stepActionHold: Boolean(stepActionHold?.missing?.length),
      sourceReviewEvidence: sourceReviewEvidence ? { status: sourceReviewEvidence.status ?? null,
        findings: (sourceReviewEvidence.findings ?? []).map(finding => ({ code: finding.code ?? null })),
        pendingDispositions: (sourceReviewEvidence.pendingDispositions ?? []).map(entry => ({ id: entry.id })) } : null,
      authoringState: authoringProgress == null ? null : { available: Boolean(authoringProgress.next),
        stage: authoringProgress.stage ?? null, generation: authoringProgress.generation ?? null },
      ...(authoringProgress?.next ? { authoringPreparesPhase:
        authoringProgress.next.command?.split(' ').slice(0, 3).join(' ') === `singularity-flow prepare ${phase?.id}` } : {}),
      applicability: applicability.map(({ responsibility, authority }) => ({ responsibility, authority })),
      prerequisites: prerequisites.map(entry => ({ timing: entry.timing ?? null,
        preparesPhase: entry.command?.split(' ').slice(0, 3).join(' ') === `singularity-flow prepare ${phase?.id}` })),
      decisionHold: Boolean(held), approvalHoldCount: groups.size, sheetPresent: Boolean(sheet),
      sheetRoute: Boolean(sheetRoute(sheet)), sheetApproves: sheet?.next?.effect === 'approves',
      visualRouteCount: visualCoverageHold?.routes?.length ?? 0, visualPublished: Boolean(visualCoverageHold?.published),
      mcpActionCount: mcpHold?.actions?.length ?? 0, mcpPhase: mcpHold?.phase ?? null
    },
    presentation: { held, approvalGroups: [...groups], applicability }
  };
}

/** Render the exact captured semantic plan; never choose another route from display strings. */
export function nextStepPlanPresentation(workflow, plan, options = {}) {
  const { prerequisites = [], modelMode = ambientModelMode(), stepActionHold = null, repositoryHost = null,
    visualCoverageHold = null, mcpHold = null, sheet = null } = options;
  const presentation = options.presentation ?? nextStepObservations(workflow, options).presentation;
  const phase = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null, workId = workflow.workItem.id;
  let progress = options.authoringProgress;
  return plan.map(entry => {
    const timing = entry.timing;
    const show = (skill, command, reason, metadata) => action(timing, skill, command, reason, metadata);
    if (entry.origin === 'guide') {
      if (entry.kind === 'resume-phase-authoring') progress ??= phaseAuthoringProgress(workflow, phase);
      const item = copilotAction(continuationActionPresentation(entry, { workflow, phase, authoringProgress: progress }));
      return show(item.skill, item.command, item.reason, item.authoringStage ? { authoringStage: item.authoringStage, preserveExistingWork: true } : {});
    }
    switch (entry.kind) {
      case 'retry-publication': return show(null, 'singularity-flow sync', 'Retry the retained commit push; workflow transitions are blocked until publication succeeds.');
      case 'recalculate-next': return show('/sflow-nextsteps', `singularity-flow nextsteps ${workId}`, 'Recalculate actions from the synchronized branch state.');
      case 'inspect-recovery': return show('/sf-recover', `singularity-flow recover ${workId}${entry.targetPhase ? ` --phase ${entry.targetPhase}` : ''}`,
        'The current bytes no longer match their consumed generation or another deterministic recovery boundary. Review the hash-bound recovery plan before continuing.',
        { operationId: 'recover.inspect', route: 'recovery' });
      case 'terminal-check': return show(null, 'singularity-flow gate --terminal', 'Confirm the completed workflow and remote branch satisfy the final gate.');
      case 'finalize-story': return show('/sflow-finalize', `singularity-flow finalize --parent ${workId}`, 'Finalize the Story for review; repository policy completes it directly, without a pull request.');
      case 'promote-story': return show('/sflow-story-branch', `singularity-flow story branch promote --parent ${workId} --mode direct`, 'After finalization, promote the finished child branch to the Story branch directly; no pull request is opened.');
      case 'preview-pull-request': return show('/sflow-pr', `singularity-flow pr ${workId}`, 'Preview the pull request title, body, base, head, checks, and evidence before publishing anything.');
      case 'copy-review-description': return show('/sflow-pr', `singularity-flow pr describe ${workId} --clipboard`, `Copy the reviewed description and open the merge request in ${repositoryHost.label} by hand; pr --create uses the GitHub CLI.`);
      case 'create-pull-request': return show('/sflow-pr', `singularity-flow pr ${workId} --create`, 'After reviewing the preview, create the pull request with explicit confirmation.');
      case 'story-progress': return show('/sflow-progress', `singularity-flow progress ${workId}`, 'Review deterministic phase completion and approvals.');
      case 'story-report': return show('/sflow-report', `singularity-flow report ${workId}`, entry.purpose === 'archived' ? 'Review the lifecycle history, timing, and cancellation record.' : 'Review timing, rework, token usage, and bottlenecks.');
      case 'list-archived-documents': return show('/sflow-documents', `singularity-flow documents list ${workId}`, 'Review the preserved artifacts for this archived Story.');
      case 'inspect-routing': {
        const pending = workflow.pendingDecision;
        const decision = (workflow.resolution?.decisions ?? []).find(item => item.id === entry.decisionId);
        const when = entry.withoutApproval ? `After ${phase.id} completes` : `After ${phase.id} is approved`;
        return show('/sflow-decide', `singularity-flow decision show ${workId}`, entry.purpose === 'pending'
          ? `'${pending.label}' waits for ${pending.by.join(', ')} to choose what happens next${pending.reason === 'limit' ? '; its rounds are used' : ''}.`
          : entry.personal ? `${when}, a person chooses what happens next ('${decision.label}').`
            : `${when}, '${decision.label}' chooses the next step from the values it records.`);
      }
      case 'choose-workflow-route': {
        const option = workflow.pendingDecision.options.find(item => item.id === entry.optionId);
        return show('/sflow-decide', `singularity-flow decision choose ${workId} --option ${entry.optionId} --reason <reason> --expected ${entry.expected}`, `Choose '${option.label}'.`);
      }
      case 'reopen-routing-phase': return show('/sflow-decide', `singularity-flow decision choose ${workId} --to ${entry.targetPhase} --reason <reason> --expected ${entry.expected}`,
        `Reopen '${workflow.phases[entry.targetPhase]?.label ?? entry.targetPhase}' instead; going back never counts as a pass.`);
      case 'cancel-story': return show('/sf-cancel', `singularity-flow cancel ${workId} --reason <reason> --confirm ${workId}`, 'Cancel this Story, preserve its artifacts, and move it to Archived.');
      case 'prepare-following-phase': {
        const target = workflow.phases[entry.targetPhase];
        let reason;
        if (entry.outcome) {
          const decision = decisionAfter(workflow, phase.id), inputs = decisionReads(decision), facts = entry.outcome;
          const outcome = { ...facts, ...(Object.hasOwn(facts, 'because') ? { because: facts.because ? describeWhen(facts.because, inputs) : null } : {}),
            ...(Object.hasOwn(facts, 'goal') ? { goal: facts.goal ? describeWhen(facts.goal, inputs) : null } : {}) };
          reason = `${entry.withoutApproval ? `After ${phase.id} completes` : `After ${phase.id} is approved`}, ${describeOutcome(workflow, outcome)}`;
        } else reason = entry.withoutApproval
          ? `After ${phase.id} submission completes its no-approval phase, generate and publish ${target.label}.`
          : `After ${phase.id} approval advances the workflow, generate and publish ${target.label}.`;
        return show(generationSkillForPhase(target, workflow), `singularity-flow prepare ${target.id}`, reason);
      }
      case 'decide-applicability': {
        const item = presentation.applicability[entry.index]; return show('/sflow-decide', item.command, item.message);
      }
      case 'pending-decisions': {
        const held = presentation.held;
        return held.personal ? show(null, held.command,
          `${held.headline} Only you record it, in your own terminal, after looking at the evidence yourself; \`${held.listCommand}\` shows its other choice, a dated risk.`, { route: 'decision-list' })
          : show('/sf-decide', `singularity-flow decisions ${workId}`,
            `${held.headline} Decide them in one place: each is shown in plain words with its choices, and its approvers record them.`, { route: 'decision-list' });
      }
      case 'approval-hold': {
        const [command, shared] = presentation.approvalGroups[entry.index];
        return show(copilotSkillForCommand(command), command, `${shared.map(hold => `${hold.who}: ${hold.summary}`).join(' ')}${shared[0].action?.label ? ` ${shared[0].action.label}` : ''}`, { route: 'approval-hold' });
      }
      case 'step-sheet': {
        const route = sheetRoute(sheet); return show(route.skill, route.command, route.reason,
          { route: route.command.startsWith('singularity-flow decisions ') ? 'decision-list' : 'approval-hold' });
      }
      case 'prerequisite': {
        const shown = copilotAction(prerequisites[entry.index]);
        return timing == null || timing === shown.timing ? shown : Object.freeze({ ...shown, timing });
      }
      case 'step-action-hold': {
        const command = stepActionHold.nextAction ?? `singularity-flow integrations status --work-id ${workId} --all`;
        return show(copilotSkillForCommand(command) ?? '/sf-integrations', command, stepActionHold.reason ?? 'The next step waits for a required after-step delivery.', { route: 'step-action-hold' });
      }
      case 'mcp-readiness': {
        const item = mcpHold.actions[entry.index]; return show(copilotSkillForCommand(item.command) ?? '/sf-mcp', item.command,
          entry.index ? item.label : `MCP readiness blocks ${phase.id} (${mcpHold.errors.length} unmet): ${item.label}`, { route: 'mcp-readiness' });
      }
      case 'visual-coverage': {
        const route = visualCoverageHold.routes[entry.index]; return show(copilotSkillForCommand(route.command), route.command,
          entry.index ? route.label : visualCoverageHold.reason, { route: 'visual-coverage' });
      }
      case 'prepare-deterministic-convergence': return show('/sflow-converge', `singularity-flow prepare ${phase.id}${entry.modelEnabled ? '' : ' --no-model'}`,
        'Compute the canonical deterministic convergence projection, then follow only its returned human-review or publication action.', { operationId: 'prepare', route: 'deterministic-convergence' });
      case 'review-application': {
        const offer = applicationReviewOffer(workflow, phase); return show(offer.copilotCommand, offer.command, offer.reason);
      }
      case 'model-required': return show('/sf-nextsteps', `singularity-flow nextsteps ${workId}`, `${phase.label} has no configured model-free producer. ${modelOffCause(modelMode)}`,
        { operationId: 'phase', modelPolicy: 'required', availability: 'blocked', route: 'none' });
      case 'publish-phase': return entry.modelEnabled ? show(generationSkillForPhase(phase, workflow), phasePublicationCommand(phase),
        `Publish ${phase.label} with its configured producer and channel.`, { operationId: 'phase', route: 'configured-producer' })
        : show(generationSkillForPhase(phase, workflow), phasePublicationCommandForMode(phase, { modelEnabled: false }),
          entry.producer === 'human' ? `Publish the ${phase.label} you authored in place, without invoking a model.` : `Publish the deterministically generated ${phase.label} without invoking a model.`,
          { operationId: 'phase', modelPolicy: 'never', route: entry.producer === 'human' ? 'manual' : 'deterministic' });
      case 'import-phase': return show(generationSkillForPhase(phase, workflow), phasePublicationCommandForProducer(phase, 'human', { source: '<FILE>', noModel: true }),
        `Or import and publish ${phase.label} from a file written elsewhere, without invoking a model.`, { operationId: 'phase', modelPolicy: 'never', route: 'manual' });
      case 'resolve-phase-inputs': return show('/sflow-inputs', `singularity-flow inputs ${phase.id}`, 'Resolve and render every enforced approved phase input before generation.');
      case 'advance-convergence': return show('/sflow-submit', `singularity-flow story advance --work-id ${workId}`, 'After deterministic publication, review every convergence disposition and explicitly confirm advancement before submission.');
      case 'review-published-source': return show('/sf-review-source', `singularity-flow review-source context ${phase.id} --json`, 'After successor publication, independently review its exact source and artifact bindings before submission.');
      case 'submit-phase': return show('/sflow-submit', `singularity-flow submit ${phase.id}${decisionSubmitArguments(workflow, phase.id)}`,
        entry.withoutApproval ? `After publishing ${phase.id}, run its checks, complete it without approval, and advance.` : `After publishing ${phase.id}, run its checks and submit it for approval.`);
      case 'approve-phase': return show('/sflow-approve', `singularity-flow approve ${phase.id} --work-id ${workId} --fetch`, `After submission, approve ${phase.id} using an authorized human Git identity; the phase agent is prompt context only.`);
      default: throw new Error(`Unknown semantic next action '${entry.kind}'.`);
    }
  });
}

export function workflowNextSteps(workflow, options = {}) {
  const { facts, presentation } = nextStepObservations(workflow, options);
  return nextStepPlanPresentation(workflow, workflowNextPlan(workflow, facts), { ...options, presentation });
}

export function nextStepsSnapshot({ initialized = true, branch = null, requestedWorkId = null, workflow = null, publicationPending = false, recovery = null, prerequisites = [], modelMode = ambientModelMode(), stepActionHold = null, sourceReviewEvidence = null, authoringProgress = null, repositoryHost = null, pendingDecisions = undefined, visualCoverageHold = null, mcpHold = null, approvalCheck = null, pending = null, sheet = null, nextPlan = null, nextPresentation = null } = {}) {
  if (!initialized) return {
    schemaVersion: 1,
    state: 'not_initialized',
    workId: null,
    currentPhase: null,
    actions: [
      action('now', null, 'singularity-flow init', 'Initialize editable Singularity Flow configuration, templates, agents, approval groups, and prompts.'),
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
  const contextBoundary = !publicationPending && !recovery?.requiresRecovery && !workflow.pendingDecision
    && !stepActionHold?.missing?.length ? contextBoundaryPresentation(pendingContextBoundary(workflow)) : null;
  const options = { publicationPending, recovery, prerequisites, modelMode, stepActionHold, sourceReviewEvidence, authoringProgress, repositoryHost, pendingDecisions, visualCoverageHold, mcpHold, approvalCheck, sheet };
  const actions = nextPlan ? nextStepPlanPresentation(workflow, nextPlan, { ...options, presentation: nextPresentation }) : workflowNextSteps(workflow, options);
  return {
    schemaVersion: 1,
    state: publicationPending ? 'publication_pending' : recovery?.requiresRecovery ? 'recovery_required' : workflow.status,
    branch: workflow.workItem.branch,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    currentPhase: workflow.currentPhase,
    modelMode: modelMode.enabled ? 'auto' : 'disabled',
    recovery: recovery?.requiresRecovery ? recovery : null,
    ...(authoringProgress ? { authoringProgress } : {}),
    ...(contextBoundary ? { contextBoundary } : {}),
    ...(stepActionHold?.missing?.length ? { stepActionHold } : {}),
    ...(mcpHold?.actions?.length ? { mcpHold } : {}),
    ...(pending ? { pending } : {}),
    actions: contextBoundary ? actions.map(entry => ({ ...entry,
      ...(entry.timing === 'now' ? { copilotTiming: 'after-context-boundary' } : {}) })) : actions
  };
}

export function nextStepsText(snapshot) {
  const lines = [
    snapshot.workId ? `${snapshot.workId} — next actions` : 'Singularity Flow — next actions',
    `State: ${snapshot.state}`,
    snapshot.branch ? `Branch: ${snapshot.branch}` : null,
    snapshot.currentPhase ? `Current phase: ${snapshot.currentPhase}` : null,
    ...(snapshot.workId ? ['Guided router:', ...commandRouteLines(safeCommandGuidance('singularity-flow next'))] : []),
    ...(snapshot.pending?.open ? [`Open on the decision list: ${snapshot.pending.open} — first: ${snapshot.pending.next.title} (${snapshot.pending.command})`] : []),
    ''
  ].filter((line) => line !== null);
  if (snapshot.contextBoundary) lines.push(...formatContextBoundaryHandoff(snapshot.contextBoundary),
    snapshot.contextBoundary.instruction,
    'Conversation reset is a Copilot chat action; the listed Shell actions remain valid.', '');
  // Every action names its three entry points in the contract order: Copilot, Shell, then the
  // model-free VS Code route. The reason leads; no surface is presented as the secondary product.
  snapshot.actions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.timing.toUpperCase()}${item.copilotTiming === 'after-context-boundary' ? ' (Copilot: after conversation boundary)' : ''} — ${item.reason}`);
    const guidance = safeCommandGuidance(item);
    if (guidance) lines.push(...commandRouteLines(guidance, '   '));
    else lines.push('   The supplied command could not be safely displayed.', ...commandRouteLines({}, '   '));
  });
  return `${lines.join('\n')}\n`;
}
