import { isConvergencePhase } from '../phase-roles.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { branch, gitDir, repoRoot } from '../git.mjs';
import { nextStepsSnapshot, nextStepsText } from '../nextsteps.mjs';
import { readPendingPublication } from '../publication-pending.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { exists, optionBoolean, readJson } from '../util.mjs';
import { validateAgentEntryRequest } from '../agent-entry-options.mjs';
import { operationContext } from '../operation-context.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { effectivePhasePublicationProducer } from '../manual-authorship.mjs';
import { storyRequiresStepActions } from '../step-actions.mjs';
import { requiresProspectivePhaseInspection } from '../code-submission-evidence.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import { readSourceReviewStatus } from '../source-review-lifecycle.mjs';
import { phaseContinuation } from '../phase-continuation.mjs';
import { collectInputs } from '../inputs.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { authoringSkillCatalog } from '../authoring-skills.mjs';
import { agentPacketPresentation } from '../agent-packet-presentation.mjs';

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
  definition = null, executionCatalog = null
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
    reason: 'Select the governed agent that will remain active for this terminal session before generation.'
  });

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

export async function resolveSnapshot(positionals, { root = repoRoot() } = {}) {
  return withApprovedConfigurationRead(root, (authority) => resolveSnapshotInScope(
    root, positionals, Boolean(authority)
  ));
}

async function resolveSnapshotInScope(root, positionals, approvedConfigurationAvailable) {
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
  if (accepted) return resolveStorySnapshot(root, accepted);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), { reference, required: false });
  if (selected?.kind === 'initiative') return initiativeSnapshot(root, selected);
  if (selected?.kind !== 'story') return nextStepsSnapshot({ initialized: true, branch: branch(root), requestedWorkId });
  return resolveStorySnapshot(root, await loadAcceptedStoryExecution(root, selected.id));
}

/** Canonical prerequisites and lifecycle routing, also used by the inputs continuation. */
export async function resolveStorySnapshot(root, { workflow, definition, executionCatalog = null }) {
  const selected = { id: workflow.workItem.id,
    location: { path: path.join(definition.workItemRoot, workflow.workItem.id, 'workflow.json') } };
  const modelMode = operationContext()?.modelMode ?? { enabled: true, source: 'default' };
  const active = activePhase(workflow);
  const consumedGenerationChanged = active?.generationIntent?.status === 'consumed'
    && Number(active.generationIntent.generation) === Number(active.generation);
  const sourceReviewEvidence = active?.status === 'in_progress' && active.generation > 0
    && sourceReviewRequired(workflow, active.id)
    ? await readSourceReviewStatus(root, definition, workflow, active.id).catch(() => null) : null;
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
  // Receipts are read from this checkout, so only the Story checked out here can be held by one.
  let stepActionHold = null;
  if (storyRequiresStepActions(workflow) && workflow.workItem?.branch === branch(root)) {
    const { requiredStepActionHold, stepActionHoldSentence } = await import('../step-action-receipts.mjs');
    const hold = await requiredStepActionHold(root, definition, workflow).catch(() => null);
    stepActionHold = hold ? { ...hold, reason: stepActionHoldSentence(hold) } : null;
  }
  return {
    ...nextStepsSnapshot({
      branch: branch(root),
      workflow,
      sourceReviewEvidence,
      stepActionHold,
      publicationPending: Boolean(await readPendingPublication(root, {
        kind: 'story', id: selected.id, migrate: false,
        roots: { workItemRoot: path.dirname(path.dirname(selected.location.path)) }
      })),
      recovery,
      prerequisites: await storyPrerequisites(root, workflow, selected, modelMode, { definition, executionCatalog }),
      modelMode
    }),
    evidence: evidenceSummary(workflow)
  };
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

export function snapshotContinuation(workflow, snapshot) {
  return phaseContinuation(workflow, { snapshot });
}

export async function nextStepsAgentPacket(workId = null) {
  const { phaseEntryContext } = await import('../phase-entry.mjs');
  const entry = await phaseEntryContext({ workId, allowTerminal: true });
  const { packet } = entry;
  if (packet.paused) return packet;
  if (!packet.ready) return { ...packet, resultType: 'sflow-nextsteps', state: 'binding-required',
    actions: packet.phaseAgent?.handoff ? [{ timing: 'now', ...packet.phaseAgent.handoff }] : [] };
  const snapshot = agentNextSteps(await resolveStorySnapshot(entry.root, entry));
  const first = snapshot.actions.find(action => action.timing === 'now');
  let inputs = null;
  if (first?.argv?.[0] === 'inputs' && first.argv[1] === packet.phase) {
    const resolved = await collectInputs(entry.root, entry.workflow, entry.phase, {
      definition: entry.definition,
      itemDirectory: path.join(entry.root, entry.definition.workItemRoot, packet.workId),
      itemRelative: path.posix.join(entry.definition.workItemRoot, packet.workId)
    });
    inputs = { phase: packet.phase, dryRun: true, ...resolved,
      records: resolved.records.map(({ content, ...record }) => record) };
  }
  return agentPacketPresentation({ ...packet, ...snapshot, resultType: 'sflow-nextsteps', inputs,
    actions: snapshot.actions.filter(action => action.timing !== 'then'),
    projection: { kind: 'agent', omitted: ['actions[timing=then]'],
      fullCommand: `singularity-flow nextsteps ${packet.workId} --json` } });
}

export async function run(_argv, { positionals, options }) {
  const forAgent = optionBoolean(options, 'for-agent');
  if (forAgent) validateAgentEntryRequest('nextsteps', { positionals, options });
  const snapshot = forAgent ? await nextStepsAgentPacket(positionals[1] ?? null) : await resolveSnapshot(positionals);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(snapshot, null, forAgent ? undefined : 2));
  else process.stdout.write(nextStepsText(snapshot));
}
