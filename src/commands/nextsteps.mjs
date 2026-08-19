import { existsSync } from 'node:fs';
import path from 'node:path';
import { branch, gitDir, repoRoot } from '../git.mjs';
import { nextStepsSnapshot, nextStepsText } from '../nextsteps.mjs';
import { readPendingPublication } from '../publication-pending.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { exists, optionBoolean, readJson } from '../util.mjs';
import { operationContext } from '../operation-context.mjs';

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

async function storyPrerequisites(root, workflow, selected, modelMode = { enabled: true }) {
  const prerequisites = [];
  const active = activePhase(workflow);
  const session = await localSession(root);
  if (active && workflow.resolution?.collaboration?.assignmentMode === 'required' && !workflow.collaboration?.assignments?.[active.id]) {
    prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Phase '${active.id}' requires an explicit assignment before the team continues.` });
  } else if (active && workflow.resolution?.collaboration?.assignmentMode === 'suggested' && !workflow.collaboration?.assignments?.[active.id]) {
    prerequisites.push({ timing: 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who is coordinating '${active.id}' so another terminal can see ownership.` });
  }
  if (active?.status === 'in_progress' && !session?.agent) prerequisites.push({
    timing: 'now', skill: '/sf-resume', command: `singularity-flow resume ${workflow.workItem.id} --fetch`,
    reason: 'Select the governed agent that will remain active for this terminal session before generation.'
  });

  const generationRequired = active && (active.generationPolicy?.requirement !== 'none')
    && (active.generation < 1 || (active.rejectedAt && !(workflow.history ?? []).some((event) => event.phase === active.id && event.event === 'phase_generated' && event.at > active.rejectedAt)));
  const groundingMode = workflow.resolution?.worldModelGrounding ?? 'off';
  if (active?.status === 'in_progress' && generationRequired && groundingMode !== 'off') {
    const { loadDefinition } = await import('../config.mjs');
    const { verifyGroundingRecord } = await import('../grounding.mjs');
    const { inspectWorkflowGrounding } = await import('../worldmodel.mjs');
    const definition = await loadDefinition(root);
    const task = workflow.workItem.title;
    const readiness = await inspectWorkflowGrounding(root, workflow, active.id, {
      agent: session?.agent ?? null,
      task
    });
    if (!readiness.availability.ready) {
      const blocks = groundingMode === 'enforce' || readiness.availability.staleness?.blocks;
      prerequisites.push({ timing: blocks ? 'now' : 'optional', skill: '/sf-worldmodel', command: readiness.command, reason: readiness.reason });
      prerequisites.push({ timing: groundingMode === 'enforce' ? 'then' : 'optional', skill: null, command: `singularity-flow wm compose --phase ${active.id} --task ${JSON.stringify(task)}`, reason: 'Compose and record the governed phase prompt using the exact same task text.' });
    } else {
      if (readiness.availability.staleness?.warns) prerequisites.push({
        timing: 'optional', skill: '/sf-worldmodel', command: readiness.command,
        reason: readiness.availability.staleness.message
      });
      const grounding = await verifyGroundingRecord(root, definition, workflow, active, { agent: session?.agent ?? null });
      if (grounding.errors.length || grounding.warnings.length) prerequisites.push({
        timing: groundingMode === 'enforce' ? 'now' : 'optional', skill: null, command: `singularity-flow wm compose --phase ${active.id} --task ${JSON.stringify(task)}`,
        reason: 'Create or refresh the required grounding record and exact prompt snapshot before publishing this generation.'
      });
    }
  }
  if (active?.status === 'in_progress' && session?.agent) {
    const { agentStatus, remoteOutputConflicts } = await import('../agents.mjs');
    const status = (await agentStatus(root, session.agent))[0];
    if (!status) prerequisites.push({ timing: 'now', skill: null, command: 'singularity-flow agents list', reason: `Active agent '${session.agent}' is no longer available; choose and sync an available pack.` });
    else if (status.status === 'unlocked') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent}`, reason: `Review and trust the active agent's remote Markdown before generation.` });
    else if (status.status === 'stale') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent} --update`, reason: 'The active agent Markdown changed after it was locked; review the new dependency hashes.' });
    if (status && !['ready', 'local-only'].includes(status.status)) prerequisites.push({ timing: ['unlocked', 'stale'].includes(status.status) ? 'then' : 'now', skill: null, command: `singularity-flow agents sync ${session.agent}`, reason: 'Verify the pinned hashes and materialize the active agent cache.' });
    const itemDirectory = path.join(root, path.dirname(selected.location.path));
    for (const conflict of await remoteOutputConflicts(active, { itemDirectory })) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents refresh-output ${conflict.resource}`, reason: `Remote output ${conflict.target} has local changes; review them before deciding whether to add --replace.` });
  }
  return prerequisites;
}

export async function resolveSnapshot(positionals, { root = repoRoot() } = {}) {
  const initialized = existsSync(path.join(root, 'singularity/workflow.yml'));
  if (!initialized) return nextStepsSnapshot({ initialized: false, branch: branch(root) });
  const requestedWorkId = positionals[1] ?? null;
  const reference = requestedWorkId ?? branch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), { reference, required: false });
  if (selected?.kind === 'initiative') return initiativeSnapshot(root, selected);
  if (selected?.kind !== 'story') return nextStepsSnapshot({ branch: branch(root), requestedWorkId });
  const workflow = selected.state;
  const modelMode = operationContext()?.modelMode ?? { enabled: true, source: 'default' };
  return {
    ...nextStepsSnapshot({
      branch: branch(root),
      workflow,
      publicationPending: Boolean(await readPendingPublication(root, {
        kind: 'story', id: selected.id, migrate: false,
        roots: { workItemRoot: path.dirname(path.dirname(selected.location.path)) }
      })),
      prerequisites: await storyPrerequisites(root, workflow, selected, modelMode),
      modelMode
    }),
    evidence: evidenceSummary(workflow)
  };
}

export async function run(_argv, { positionals, options }) {
  const snapshot = await resolveSnapshot(positionals);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(snapshot, null, 2));
  else process.stdout.write(nextStepsText(snapshot));
}
