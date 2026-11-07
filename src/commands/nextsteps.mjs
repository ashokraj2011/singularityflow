import { existsSync } from 'node:fs';
import path from 'node:path';
import { branch, repoRoot } from '../git.mjs';
import { nextStepsSnapshot, nextStepsText } from '../nextsteps.mjs';
import { optionBoolean } from '../util.mjs';
import { phaseNeedsGeneration } from '../sequence.mjs';
import { validateAgentEntryRequest } from '../agent-entry-options.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { phaseContinuation } from '../phase-continuation.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { authoringSkillCatalog } from '../authoring-skills.mjs';
import { agentOrIndentedJson, agentPacketPresentation } from '../agent-packet-presentation.mjs';
import { repositoryCheckStatus } from '../repository-check-cache.mjs';

import { recordedEvidenceSummary as evidenceSummary } from '../kernel/phase-policy.mjs';

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

export { storyPrerequisites } from '../engine-compatibility/git-nextsteps.mjs';

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
export async function resolveStorySnapshot(root, accepted, observationOptions = {}) {
  const { workflow, definition } = accepted;
  const { createGitStoryNextEngine } = await import('../engine-compatibility/git-nextsteps.mjs');
  const binding = createGitStoryNextEngine({ root, accepted, observationOptions });
  const result = await binding.engine.run('story.next', { workId: workflow.workItem.id });
  const captured = binding.presentation().presentation;
  const { active, documentReadiness } = captured;
  const { authoringProgress, sheet, publicationPending: listPublication } = captured.options;
  const snapshot = {
    ...nextStepsSnapshot({ ...captured.options, nextPlan: result.manifest.actions, nextPresentation: captured.planningPresentation }),
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
    const { collectInputs } = await import('../engine-compatibility/nextsteps-deferred.mjs');
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
