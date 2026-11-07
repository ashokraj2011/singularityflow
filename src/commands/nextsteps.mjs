import { isConvergencePhase, isVisualVerificationPhase } from '../kernel/phase-policy.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { branch, gitDir, remoteUrl, repoRoot } from '../git.mjs';
import { classifyGitHost } from '../git-host.mjs';
import { nextStepsSnapshot, nextStepsText } from '../nextsteps.mjs';
import { readPendingPublication } from '../publication-pending.mjs';
import { exists, optionBoolean, readJson } from '../util.mjs';
import { phaseNeedsGeneration } from '../sequence.mjs';
import { validateAgentEntryRequest } from '../agent-entry-options.mjs';
import { operationContext } from '../operation-context.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { effectivePhasePublicationProducer } from '../kernel/phase-policy.mjs';
import { storyRequiresStepActions } from '../step-actions.mjs';
import { requiresProspectivePhaseInspection } from '../kernel/phase-policy.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import { phaseContinuation } from '../phase-continuation.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { authoringSkillCatalog } from '../authoring-skills.mjs';
import { agentOrIndentedJson, agentPacketPresentation } from '../agent-packet-presentation.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';
import { repositoryCheckStatus } from '../repository-check-cache.mjs';
import { groundingRecordRelative } from '../story-paths.mjs';

async function localSession(root) {
  const target = path.join(gitDir(root), 'singularity-flow', 'session.json');
  return await exists(target) ? readJson(target) : null;
}

function activePhase(workflow) {
  return workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
}

/** Evidence already present in durable lifecycle state; this performs no test or tool invocation. */
function evidenceSummary(workflow) {
  const phases = (workflow.phaseOrder ?? []).map((id) => workflow.phases?.[id]).filter(Boolean);
  const artifacts = phases.flatMap((phase) => phase.artifacts ?? []);
  const checks = phases.flatMap((phase) => phase.checks ?? []);
  const approvals = phases.flatMap((phase) => phase.approvals ?? [])
    .filter((entry) => !entry.invalidatedAt);
  return {
    artifacts: {
      recorded: artifacts.filter((entry) => entry.sha256 || entry.recordedAt || entry.status === 'recorded').length,
      total: artifacts.length
    },
    checks: {
      passed: checks.filter((entry) => ['passed', 'pass'].includes(entry.status)).length,
      failed: checks.filter((entry) => ['failed', 'blocked', 'fail'].includes(entry.status)).length,
      total: checks.length
    },
    approvals: {
      approved: approvals.filter((entry) => entry.decision === 'approved').length,
      total: approvals.length
    }
  };
}

async function initiativeSnapshot(root, selected) {
  const { initiativeNextActions } = await import('../initiative-report.mjs');
  const initiative = selected.state;
  return {
    schemaVersion: 1,
    state: initiative.status ?? 'active',
    subject: { kind: 'initiative', id: selected.id },
    initiativeId: selected.id,
    currentPhase: initiative.currentPhase ?? null,
    actions: (await initiativeNextActions(root, selected.id)).map((item) => ({
      timing: 'now', skill: null, command: item.command, reason: item.reason
    })),
    evidence: evidenceSummary(initiative)
  };
}

export async function storyPrerequisites(root, workflow, selected, modelMode = { enabled: true }, {
  definition = null, executionCatalog = null, observeFile = null
} = {}) {
  const prerequisites = [];
  const active = activePhase(workflow);
  const authoring = Boolean(active) && requiresProspectivePhaseInspection(workflow, active);
  const session = await localSession(root);
  const activeSessionAgent = session?.workId === workflow.workItem.id
      && session?.phaseId === active?.id
    ? session.agent
    : null;
  const activeAgent = activeSessionAgent ?? active?.defaultAgent ?? null;
  const deterministicConvergence = isConvergencePhase(active)
    && effectivePhasePublicationProducer(active, {
      modelEnabled: modelMode.enabled
    }) === 'deterministic';
  if (active && workflow.resolution?.collaboration?.assignmentMode === 'required' && !workflow.collaboration?.assignments?.[active.id]) {
    prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Phase '${active.id}' requires an explicit assignment before the team continues.` });
  } else if (active && workflow.resolution?.collaboration?.assignmentMode === 'suggested' && !workflow.collaboration?.assignments?.[active.id]) {
    prerequisites.push({ timing: 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who is coordinating '${active.id}' so another terminal can see ownership.` });
  }
  if (authoring && !activeSessionAgent && !deterministicConvergence) prerequisites.push({
    timing: 'now', skill: '/sf-resume', command: `singularity-flow resume ${workflow.workItem.id} --fetch`,
    reason: 'Select the agent that will remain active for this terminal session before generation.'
  });

  // The lifecycle's own freshness rule: a phase reopened as downstream rework or by a skill
  // amendment needs a new generation, and a prompt composed for it, as much as a never-published
  // one. Entry-capable authoring skills fold this into their entry; any other skill keeps it.
  if (active?.status === 'in_progress' && !deterministicConvergence && phaseNeedsGeneration(workflow, active)) {
    const { loadDefinition } = await import('../config.mjs');
    definition ??= await loadDefinition(root);
    if (!(await composedPromptCurrent(root, definition, workflow, active, observeFile))) {
      // A clarification is recorded against the composed prompt (clarification record refuses
      // without it). Where publication requires that record (a required checkpoint on an
      // agent-authored step), composing comes first, not optionally; elsewhere it stays optional
      // and says that recording an answer needs it.
      const { resolvedClarificationPolicy } = await import('../clarifications.mjs');
      let clarification = 'off';
      let recordRequired = false;
      try {
        clarification = resolvedClarificationPolicy(definition, workflow, active).mode;
        recordRequired = clarification === 'required'
          && effectivePhasePublicationProducer(active, { modelEnabled: modelMode.enabled }) === 'governed-agent';
      } catch { /* validate reports an invalid policy */ }
      prerequisites.push({
        timing: recordRequired ? 'now' : 'optional', skill: null,
        command: `singularity-flow wm compose --phase ${active.id}`,
        route: 'grounding-composition',
        reason: recordRequired
          ? 'Compose the phase prompt for this generation first: its required clarification is recorded against that prompt, and clarification record refuses until it exists.'
          : clarification !== 'off'
            ? 'Compose the phase prompt for this generation before authoring and publishing it; recording a clarification answer needs it first.'
            : 'Compose the phase prompt for this generation before authoring and publishing it.'
      });
    }
  }
  if (authoring && activeSessionAgent && !deterministicConvergence) {
    const { agentStatus, remoteOutputConflicts } = await import('../agents.mjs');
    // Accepted agents execute their verified closure, not today's mutable live catalog.
    if (!executionCatalog?.agents?.[activeSessionAgent]) {
      const status = (await agentStatus(root, activeSessionAgent))[0];
      if (!status) prerequisites.push({ timing: 'now', skill: null, command: 'singularity-flow agents list', reason: `Active agent '${activeSessionAgent}' is no longer available; choose and sync an available pack.` });
      else if (status.status === 'unlocked') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${activeSessionAgent}`, reason: `Review and trust the active agent's remote Markdown before generation.` });
      else if (status.status === 'stale') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent} --update`, reason: 'The active agent Markdown changed after it was locked; review the new dependency hashes.' });
      if (status && !['ready', 'local-only'].includes(status.status)) prerequisites.push({ timing: ['unlocked', 'stale'].includes(status.status) ? 'then' : 'now', skill: null, command: `singularity-flow agents sync ${session.agent}`, reason: 'Verify the pinned hashes and materialize the active agent cache.' });
    }
    const itemDirectory = path.join(root, path.dirname(selected.location.path));
    for (const conflict of await remoteOutputConflicts(active, { itemDirectory })) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents refresh-output ${conflict.resource}`, reason: `Remote output ${conflict.target} has local changes; review them before deciding whether to add --replace.` });
  }
  return prerequisites;
}

/** Whether the phase's next generation has a composed prompt whose snapshot still matches its record. */
async function composedPromptCurrent(root, definition, workflow, phase, observeFile = null) {
  const relative = groundingRecordRelative(definition, workflow, phase);
  await observeFile?.(relative);
  const record = await readJson(path.join(root, relative)).catch(() => null);
  if (typeof record?.promptPath !== 'string' || typeof record.renderedSha256 !== 'string') return false;
  await observeFile?.(record.promptPath);
  const prompt = await readFile(path.join(root, record.promptPath)).catch(() => null);
  return prompt != null && createHash('sha256').update(prompt).digest('hex') === record.renderedSha256.replace(/^sha256:/u, '');
}

/**
 * `modelMode` names the routes to offer (a model-free publication route or the governed agent's);
 * it never permits a model. Absent, the operation's own mode is used, as before. The gateway passes
 * the mode of the CLI run it is serving, because its planners themselves run model-disabled.
 */
export async function resolveSnapshot(positionals, { root = repoRoot(), modelMode = null } = {}) {
  return withApprovedConfigurationRead(root, (authority) => resolveSnapshotInScope(
    root, positionals, Boolean(authority), modelMode
  ));
}

async function resolveSnapshotInScope(root, positionals, approvedConfigurationAvailable, modelMode = null) {
  const initialized = approvedConfigurationAvailable
    || existsSync(path.join(root, 'singularity/workflow.yml'));
  if (!initialized) return nextStepsSnapshot({ initialized: false, branch: branch(root) });
  const requestedWorkId = positionals[1] ?? null;
  const reference = requestedWorkId ?? branch(root);
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  // Try the accepted checkout before reopening today's mutable workflow/agent catalog.
  let accepted = null;
  try { accepted = await loadAcceptedStoryExecution(root, reference); }
  catch (error) { if (error?.code !== 'STORY_NOT_FOUND') throw error; }
  if (accepted) return resolveStorySnapshot(root, accepted, { modelMode });
  const { buildRepositorySubjectIndex, resolveContext } = await import('../repository-subject-index.mjs');
  const selected = resolveContext(await buildRepositorySubjectIndex(root), { reference, required: false });
  if (selected?.kind === 'initiative') return initiativeSnapshot(root, selected);
  if (selected?.kind !== 'story') return nextStepsSnapshot({ initialized: true, branch: branch(root), requestedWorkId });
  return resolveStorySnapshot(root, await loadAcceptedStoryExecution(root, selected.id), { modelMode });
}

/** Canonical prerequisites and lifecycle routing, also used by the inputs continuation. */
export async function resolveStorySnapshot(root, { workflow, definition, executionCatalog = null }, {
  observeFile = null, publicationPending = undefined, modelMode: routeModelMode = null
} = {}) {
  const selected = { id: workflow.workItem.id,
    location: { path: path.join(definition.workItemRoot, workflow.workItem.id, 'workflow.json') } };
  const modelMode = routeModelMode ?? operationContext()?.modelMode ?? { enabled: true, source: 'default' };
  const active = activePhase(workflow);
  const { phaseAuthoringProgress, readPhaseDraftEvidence } = await import('../phase-authoring-progress.mjs');
  const pendingAuthoring = phaseAuthoringProgress(workflow, active);
  const authoringProgress = pendingAuthoring ? phaseAuthoringProgress(workflow, active, {
    draftEvidence: await measureCommandSpan('nextsteps.draft-evidence', () => readPhaseDraftEvidence(root, definition, workflow, active, { observeFile }))
  }) : null;
  const consumedGenerationChanged = active?.generationIntent?.status === 'consumed'
    && Number(active.generationIntent.generation) === Number(active.generation);
  const sourceReviewEvidence = active?.status === 'in_progress' && active.generation > 0
    && sourceReviewRequired(workflow, active.id)
    ? await (await import('./nextsteps-deferred.mjs'))
      .readSourceReviewStatus(root, definition, workflow, active.id).catch(() => null) : null;
  // Full publication preflight can inspect a large source change set. `nextsteps` only needs it
  // automatically at the lifecycle state that otherwise causes the retry loop: a consumed code
  // generation whose bytes may have changed. Ordinary authoring readiness stays with /sf-phase.
  let recovery = null;
  if (consumedGenerationChanged) {
    // Keep the normal next-step path lightweight. These domains reach configuration, delivery,
    // projection, and agent code and are needed only for this exceptional lifecycle state.
    const { recoveryPlan } = await import('../collaboration.mjs');
    recovery = await recoveryPlan(root, definition, workflow, {
      phaseId: active.id
    });
  }
  // Decisions approval would refuse for: the list replaces that approval (parity with the engine).
  const pendingDecisions = active ? await measureCommandSpan('nextsteps.pending-decisions', async () =>
    (await import('../decision-list-facts.mjs')).pendingDecisionSummary(root, definition, workflow, active)).catch(() => undefined) : undefined;
  // What else approval would be refused for: the gate's own preview (SPEC-OAP M1), only while it waits.
  const checked = active?.status === 'awaiting_approval'
    ? await measureCommandSpan('nextsteps.approval-check', async () =>
      (await (await import('../approval-check.mjs')).approvalAdvisories(root, definition, workflow, active))?.approvalCheck ?? null).catch(() => null) : null;
  const approvalCheck = pendingDecisions?.count ? null : checked;
  // Receipts are read from this checkout, so only the Story checked out here can be held by one.
  let stepActionHold = null;
  if (storyRequiresStepActions(workflow) && workflow.workItem?.branch === branch(root)) {
    const { requiredStepActionHold, stepActionHoldSentence } = await import('../step-action-receipts.mjs');
    const hold = await requiredStepActionHold(root, definition, workflow).catch(() => null);
    stepActionHold = hold ? { ...hold, reason: stepActionHoldSentence(hold) } : null;
  }
  const documentReadiness = active ? await (await import('../document-runtime.mjs')).phaseDocumentReadiness(
    root, definition, workflow, active.id) : null;
  // Enforced visual coverage, read as the step's publication or its submission will check it.
  const visualCoverageHold = active?.status === 'in_progress' && isVisualVerificationPhase(active)
    && workflow.resolution?.verification?.coverage === 'enforce'
    ? await (await import('../visual-coverage.mjs')).visualCoverageHold(root, workflow, active, {
      itemDirectory: path.join(root, path.dirname(selected.location.path)), published: !phaseNeedsGeneration(workflow, active)
    }).catch(() => null) : null;
  // A step that needs an MCP server refuses prepare, publish and submit until its host, warm proof,
  // attestation, authorized origin and smoke hold here; name what is missing instead of a refusing
  // prepare. Read-only: nothing is started, warmed or smoked.
  let mcpHold = null;
  if (active?.status === 'in_progress' && active.mcp?.requiredServers?.length) {
    const { inspectMcpPhaseReadiness } = await import('../mcp-readiness.mjs');
    const readiness = await measureCommandSpan('nextsteps.mcp-readiness',
      () => inspectMcpPhaseReadiness(root, workflow, active)).catch(() => null);
    if (readiness && !readiness.ready) mcpHold = { phase: active.id, errors: readiness.errors, actions: readiness.actions };
  }
  // The one list's count and first item, read the way readiness reads them [SPEC-OAP M3].
  const listPublication = publicationPending ?? Boolean(await readPendingPublication(root, { kind: 'story', id: selected.id, migrate: false,
    roots: { workItemRoot: path.dirname(path.dirname(selected.location.path)) } }).catch(() => null));
  let sheet = null;
  const pending = active && active.id === workflow.currentPhase ? await measureCommandSpan('nextsteps.pending-list', async () => {
    const [{ readPendingList }, { pendingSummary }] = await Promise.all([import('../decision-list-reads.mjs'), import('../decision-list.mjs')]);
    const list = await readPendingList(root, definition, workflow, { phaseId: active.id, reuse: false, offline: true, publication: listPublication,
      ...(active.status === 'awaiting_approval' ? { approvalCheck: checked } : {}) });
    sheet = list.sheet ?? null;
    return pendingSummary(list);
  }).catch(() => null) : null;
  const snapshot = {
    ...nextStepsSnapshot({
      branch: branch(root),
      workflow,
      authoringProgress,
      sourceReviewEvidence,
      stepActionHold,
      publicationPending: listPublication,
      recovery,
      pendingDecisions,
      approvalCheck,
      visualCoverageHold,
      // Landing routes depend on the host: the GitHub CLI cannot open another host's merge request.
      repositoryHost: classifyGitHost(remoteUrl(root, definition.git?.remote ?? 'origin')),
      prerequisites: await measureCommandSpan('nextsteps.prerequisites', () => storyPrerequisites(root, workflow, selected, modelMode, { definition, executionCatalog, observeFile })),
      modelMode,
      mcpHold,
      pending,
      sheet
    }),
    evidence: evidenceSummary(workflow),
    repositoryChecks: repositoryCheckStatus(root),
    ...(sheet ? { sheet } : {})
  };
  if (active) snapshot.taskResume = await (await import('../workflow-task-store.mjs')).readWorkflowTaskResume(root, workflow, active, {
    published: !phaseNeedsGeneration(workflow, active), pendingPublication: listPublication,
    nextAction: snapshot.actions.find(action => action.timing === 'now'),
    progress: { state: authoringProgress?.draft?.draftModified ? 'repair-draft' : 'load-context' }
  });
  if (documentReadiness?.status !== 'ready' && documentReadiness) return { ...snapshot,
    state: 'documents-required', documentReadiness,
    actions: documentReadiness.missing.map(record => ({ timing: 'now', ...record.commandGuidance,
      reason: `Re-upload ${record.id} — ${record.name} on this laptop, preserving its existing ID and SHA-256. Then resume this phase.` })) };
  return snapshot;
}

/** Only entry-capable authoring skills can compose inline; every other prerequisite survives. */
export function agentNextSteps(snapshot) {
  const entrySkills = authoringSkillCatalog().map(entry => `/${entry.id}`);
  const draft = snapshot.actions.find(action => action.timing === 'now'
    && entrySkills.includes(action.copilotCommand)
    && action.argv?.[0] === 'prepare');
  if (!draft) return snapshot;
  const compose = snapshot.actions.filter(action => {
    if (action.route !== 'grounding-composition') return false;
    // Prerequisite producers may supply a command without argv; validate its canonical form
    // instead of assuming every durable/presentation action has already been normalized.
    const argv = safeCommandGuidance(action)?.argv;
    return argv?.length === 4 && argv[0] === 'wm' && argv[1] === 'compose'
      && argv[2] === '--phase' && argv[3] === snapshot.currentPhase;
  });
  if (!compose.length) return snapshot;
  return { ...snapshot, actions: snapshot.actions.filter(action => !compose.includes(action)),
    preparation: { compositionRequired: true, actions: compose,
      fulfilledBy: draft.copilotCommand, automaticAdvance: false } };
}

/**
 * What `nextsteps --for-agent` shows of a snapshot: the later (`then`) steps are left to the full
 * command it names. One rule for the CLI's agent entry and the gateway's `work.nextsteps` read, so
 * the two cannot list different actions.
 */
export function agentNextStepsView(snapshot) {
  // The resume state's next step is usually the first `now` action; the list says it once. A different
  // step (an interrupted operation to inspect first) stays, and the tool answer's byte limit holds.
  const { nextAction: _listed, ...resume } = snapshot.taskResume ?? {};
  const listed = JSON.stringify(snapshot.taskResume?.nextAction) === JSON.stringify(snapshot.actions.find(action => action.timing === 'now'));
  // No agent reads the step sheet yet, so it costs no agent a token (study 6.6, S3).
  const { sheet: _unread, ...read } = snapshot;
  return { ...read, actions: snapshot.actions.filter(action => action.timing !== 'then'),
    ...(snapshot.taskResume && listed ? { taskResume: resume } : {}),
    projection: { kind: 'agent', omitted: ['actions[timing=then]'],
      fullCommand: ['singularity-flow nextsteps', snapshot.workId, '--json'].filter(Boolean).join(' ') } };
}

export function snapshotContinuation(workflow, snapshot) {
  return phaseContinuation(workflow, { snapshot });
}

export async function nextStepsAgentPacket(workId = null, { cwd = process.cwd() } = {}) {
  const { phaseEntryContext } = await import('../phase-entry-context.mjs');
  const entry = await phaseEntryContext({ cwd, workId, allowTerminal: true, turnMode: 'kernel-only' });
  const { packet } = entry;
  if (packet.paused) return packet;
  if (!packet.ready) return { ...packet, resultType: 'sflow-nextsteps', state: 'binding-required',
    actions: packet.phaseAgent?.handoff ? [{ timing: 'now', ...packet.phaseAgent.handoff }] : [] };
  const snapshot = agentNextSteps(await resolveStorySnapshot(entry.root, entry));
  const first = snapshot.actions.find(action => action.timing === 'now');
  let inputs = null;
  if (first?.argv?.[0] === 'inputs' && first.argv[1] === packet.phase) {
    const { collectInputs } = await import('./nextsteps-deferred.mjs');
    const resolved = await collectInputs(entry.root, entry.workflow, entry.phase, {
      definition: entry.definition,
      itemDirectory: path.join(entry.root, entry.definition.workItemRoot, packet.workId),
      itemRelative: path.posix.join(entry.definition.workItemRoot, packet.workId)
    });
    inputs = { phase: packet.phase, dryRun: true, ...resolved,
      records: resolved.records.map(({ content, ...record }) => record) };
  }
  const { contextBoundary: entryBoundary, ...bindingPacket } = packet;
  const view = agentNextStepsView(snapshot);
  return agentPacketPresentation({ ...bindingPacket, ...view, resultType: 'sflow-nextsteps', inputs });
}

export async function run(_argv, { positionals, options }) {
  const forAgent = optionBoolean(options, 'for-agent');
  if (forAgent) validateAgentEntryRequest('nextsteps', { positionals, options });
  const snapshot = forAgent ? await nextStepsAgentPacket(positionals[1] ?? null) : await resolveSnapshot(positionals);
  if (optionBoolean(options, 'json')) console.log(agentOrIndentedJson(forAgent, snapshot));
  else process.stdout.write(nextStepsText(snapshot));
}
