import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadDefinition } from './config.mjs';
import { identity } from './git.mjs';
import { registerInitiativeEvidence, recordSha256 } from './initiative-evidence.mjs';
import {
  initiativeBreakdownDocument, loadInitiativeBreakdown, validateInitiativeBreakdown
} from './initiative-repositories.mjs';
import {
  loadInitiative, saveInitiative, secureInitiativePath
} from './initiative-state.mjs';
import {
  worldModelCommit, worldModelRebuildReason, worldModelSourceSnapshot
} from './grounding.mjs';
import {
  nowIso, SingularityFlowError, snapshot, writeText
} from './util.mjs';

export const EPIC_PHASES = Object.freeze({
  intake: 'epic-intake',
  requirements: 'epic-requirements',
  planning: 'epic-planning',
  publish: 'epic-publish'
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function render(text, values) {
  return text.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? '');
}

function planningOutput(initiative, id) {
  const output = initiative.phases?.[EPIC_PHASES.planning]?.outputs?.[id];
  if (!output) throw new SingularityFlowError(`Epic Planning has no '${id}' output.`);
  return output;
}

export async function assertEpicWorldModelReady(root) {
  const definition = await loadDefinition(root);
  const reason = await worldModelRebuildReason(root, definition);
  if (reason) {
    throw new SingularityFlowError(`${reason} Generate the repository world model before continuing to Requirements.`);
  }
  const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  const source = await worldModelSourceSnapshot(root, definition);
  const manifest = JSON.parse(await readFile(path.join(root, outputDir, 'manifest.json'), 'utf8'));
  const commit = worldModelCommit(root, outputDir);
  if (!commit || manifest.source_tree_sha256 !== source.sha256) {
    throw new SingularityFlowError('The repository world model does not match the current source tree. Generate it again before continuing.');
  }
  return {
    outputDir,
    commit,
    sourceTreeSha256: source.sha256,
    generatedAt: manifest.generated_at ?? manifest.generatedAt ?? null,
    manifestSha256: sha256(JSON.stringify(manifest))
  };
}

/**
 * Intake is collection, not an approval ceremony. Once the repository model is
 * exact and committed, record machine evidence and move to Requirements.
 */
export async function completeEpicIntake(root, initiativeId, { persona = null } = {}) {
  let { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.resolution.profile !== 'epic-planning') {
    throw new SingularityFlowError('Automatic Intake completion is available only for the Epic planning profile.');
  }
  if (initiative.currentPhase !== EPIC_PHASES.intake) {
    return { portfolio, initiative, worldModel: await assertEpicWorldModelReady(root), advanced: false };
  }
  const worldModel = await assertEpicWorldModelReady(root);
  await registerInitiativeEvidence(root, {
    initiativeId,
    phaseId: EPIC_PHASES.intake,
    checkId: 'repository-grounded',
    assurance: 'machine-verified',
    verificationMethod: 'exact-source-tree-world-model',
    source: {
      externalId: worldModel.commit,
      version: worldModel.sourceTreeSha256,
      observedState: `World model generated ${worldModel.generatedAt ?? 'at an unavailable timestamp'} from exact source tree ${worldModel.sourceTreeSha256}`
    },
    persona
  });
  ({ portfolio, initiative } = await loadInitiative(root, initiativeId));
  const phase = initiative.phases[EPIC_PHASES.intake];
  const at = nowIso();
  phase.status = 'approved';
  phase.approvedAt = at;
  const next = initiative.phases[EPIC_PHASES.requirements];
  next.status = 'in_progress';
  next.startedAt ??= at;
  initiative.currentPhase = EPIC_PHASES.requirements;
  initiative.history.push({
    at,
    actor: 'singularity-flow',
    persona,
    event: 'epic_intake_completed',
    phase: EPIC_PHASES.intake,
    detail: `repository grounded at ${worldModel.commit.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, worldModel, advanced: true };
}

/**
 * Materialize one editable, hash-addressed specification per planned Story and
 * refresh the machine-readable index. Re-running is safe: existing authored
 * Story specs are preserved and only their index hashes are refreshed.
 */
export async function prepareEpicStorySpecifications(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const indexOutput = planningOutput(initiative, 'story-specification-index');
  const indexTarget = await secureInitiativePath(root, portfolio, initiativeId, indexOutput.path, {
    label: 'Epic Story specification index'
  });
  const templateTarget = path.join(root, portfolio.templatesRoot, 'initiatives/epic/story-spec.md');
  const template = await readFile(templateTarget, 'utf8');
  const planningDir = path.posix.dirname(indexOutput.path);
  const stories = [];
  for (const story of breakdown.stories) {
    const relative = path.posix.join('stories', story.planId, 'story-spec.md');
    const target = await secureInitiativePath(root, portfolio, initiativeId, path.posix.join(planningDir, relative), {
      label: `Story specification '${story.planId}'`
    });
    await mkdir(path.dirname(target.absolute), { recursive: true });
    const content = story.specification?.trim()
      ? `# Story Specification — ${story.planId}\n\n- Epic: \`${initiativeId}\`\n- Plan ID: \`${story.planId}\`\n\n${story.specification.trim()}\n`
      : render(template, { workId: initiativeId, storyId: story.planId });
    await writeText(target.absolute, content);
    const current = await snapshot(target.absolute);
    stories.push({
      planId: story.planId,
      path: relative,
      sha256: current.sha256,
      bytes: current.size
    });
  }
  const index = { version: 1, epicId: initiativeId, stories };
  await writeText(indexTarget.absolute, YAML.stringify(index));
  return { index, path: indexTarget.relative };
}

export async function verifyEpicPlanningPackage(root, portfolio, initiative) {
  const errors = [];
  const passes = [];
  let breakdown;
  try {
    breakdown = await loadInitiativeBreakdown(root, portfolio, initiative.initiative.id);
    validateInitiativeBreakdown(breakdown, portfolio);
  } catch (error) {
    return { valid: false, errors: [error.message], passes, storySpecifications: [] };
  }
  const indexOutput = planningOutput(initiative, 'story-specification-index');
  const indexTarget = await secureInitiativePath(root, portfolio, initiative.initiative.id, indexOutput.path, {
    label: 'Epic Story specification index',
    mustExist: true,
    type: 'file'
  });
  let index;
  try { index = YAML.parse(await readFile(indexTarget.absolute, 'utf8')); }
  catch (error) { return { valid: false, errors: [`Story specification index is invalid YAML: ${error.message}`], passes, storySpecifications: [] }; }
  const indexed = new Map((index?.stories ?? []).map((entry) => [entry.planId, entry]));
  const records = [];
  const planningDirectory = path.posix.dirname(indexOutput.path);
  for (const story of breakdown.stories) {
    if (!story.specification?.trim()) {
      errors.push(`${story.planId} has no complete specification in the Story plan`);
    }
    const entry = indexed.get(story.planId);
    if (!entry) {
      errors.push(`${story.planId} has no Story specification`);
      continue;
    }
    if (!/^stories\/[A-Za-z0-9._-]+\/story-spec\.md$/.test(entry.path ?? '')) {
      errors.push(`${story.planId} Story specification path is outside the Planning package`);
      continue;
    }
    const target = await secureInitiativePath(
      root,
      portfolio,
      initiative.initiative.id,
      path.posix.join(planningDirectory, entry.path),
      { label: `Story specification '${story.planId}'`, mustExist: true, type: 'file' }
    );
    const current = await snapshot(target.absolute);
    if (entry.sha256 !== current.sha256 || entry.bytes !== current.size) {
      errors.push(`${story.planId} Story specification differs from its index hash`);
      continue;
    }
    records.push({ planId: story.planId, path: target.relative, sha256: current.sha256, bytes: current.size });
  }
  for (const planId of indexed.keys()) {
    if (!breakdown.stories.some((story) => story.planId === planId)) errors.push(`Story specification index contains unknown ${planId}`);
  }
  if (!errors.length) passes.push(`${records.length} Story specifications are present and hash-bound`);
  return {
    valid: errors.length === 0,
    errors,
    passes,
    storySpecifications: records,
    packageSha256: recordSha256(records)
  };
}

function assertStoryPlanningEditable(initiative) {
  const phase = initiative.phases[EPIC_PHASES.planning];
  if (!phase) throw new SingularityFlowError('Epic does not configure the Planning package.');
  if (!['in_progress', 'approved'].includes(phase.status)) {
    throw new SingularityFlowError(`Story edits are available when Planning is in progress or approved; it is '${phase.status}'.`);
  }
  return phase;
}

function nextStoryPlanId(breakdown) {
  const highest = breakdown.stories.reduce((maximum, story) => {
    const match = String(story.planId ?? story.id).match(/^STORY-(\d+)$/);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return `STORY-${String(highest + 1).padStart(3, '0')}`;
}

async function persistEpicStoryPlan(root, portfolio, initiative, breakdown, {
  event,
  detail
}) {
  const phase = assertStoryPlanningEditable(initiative);
  const normalized = validateInitiativeBreakdown(initiativeBreakdownDocument(breakdown), portfolio);
  normalized.initiativeId = initiative.initiative.id;
  const document = YAML.stringify(initiativeBreakdownDocument(normalized));
  const breakdownTarget = await secureInitiativePath(root, portfolio, initiative.initiative.id, 'breakdown.yml', {
    label: `Epic '${initiative.initiative.id}' Story plan`,
    mustExist: true,
    type: 'file'
  });
  await writeText(breakdownTarget.absolute, document);
  const output = planningOutput(initiative, 'story-plan');
  const outputTarget = await secureInitiativePath(root, portfolio, initiative.initiative.id, output.path, {
    label: 'Epic Story-plan artifact'
  });
  await writeText(outputTarget.absolute, document);
  const current = await snapshot(outputTarget.absolute);
  Object.assign(output, {
    status: 'draft',
    sha256: current.sha256,
    bytes: current.size,
    approvedAt: null
  });
  const invalidatedAt = nowIso();
  for (const approval of phase.approvals ?? []) {
    if (!approval.invalidatedAt) approval.invalidatedAt = invalidatedAt;
  }
  phase.status = 'in_progress';
  phase.approvedAt = null;
  initiative.currentPhase = EPIC_PHASES.planning;
  initiative.status = 'in_progress';
  initiative.materialization = { status: 'not_started', attempts: [] };
  initiative.childStories = {};
  const publishPhase = initiative.phases[EPIC_PHASES.publish];
  if (publishPhase) {
    publishPhase.status = 'not_started';
    publishPhase.startedAt = null;
    publishPhase.approvedAt = null;
    for (const outputState of Object.values(publishPhase.outputs ?? {})) {
      Object.assign(outputState, { status: 'not_generated', generation: 0, sha256: null, bytes: 0 });
    }
    for (const approval of publishPhase.approvals ?? []) {
      if (!approval.invalidatedAt) approval.invalidatedAt = invalidatedAt;
    }
  }
  initiative.history.push({
    at: invalidatedAt,
    actor: 'singularity-flow',
    event,
    phase: EPIC_PHASES.planning,
    detail
  });
  await saveInitiative(root, portfolio, initiative);
  const specifications = await prepareEpicStorySpecifications(root, initiative.initiative.id);
  const fresh = await loadInitiative(root, initiative.initiative.id);
  return { ...fresh, breakdown: normalized, specifications };
}

export async function updateEpicStory(root, initiativeId, planId, changes = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  assertStoryPlanningEditable(initiative);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const story = breakdown.stories.find((entry) => entry.planId === planId);
  if (!story) throw new SingularityFlowError(`Epic '${initiativeId}' has no planned Story '${planId}'.`);
  const allowed = new Set([
    'title', 'description', 'repository', 'suggestedWorkType', 'blocking',
    'requirements', 'acceptanceCriteria', 'dependsOn', 'specification', 'metadata', 'tasks'
  ]);
  const unexpected = Object.keys(changes).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new SingularityFlowError(`Unsupported Story fields: ${unexpected.join(', ')}.`);
  Object.assign(story, structuredClone(changes));
  const saved = await persistEpicStoryPlan(root, portfolio, initiative, breakdown, {
    event: 'epic_story_updated',
    detail: `${planId}: ${Object.keys(changes).join(', ')}`
  });
  return {
    ...saved,
    story: saved.breakdown.stories.find((entry) => entry.planId === planId),
    changed: Object.keys(changes)
  };
}

export async function splitEpicStory(root, initiativeId, sourcePlanId, changes = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  assertStoryPlanningEditable(initiative);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const source = breakdown.stories.find((entry) => entry.planId === sourcePlanId);
  if (!source) throw new SingularityFlowError(`Epic '${initiativeId}' has no planned Story '${sourcePlanId}'.`);
  const epic = breakdown.epics.find((entry) => entry.stories.some((story) => story.planId === sourcePlanId));
  const planId = nextStoryPlanId(breakdown);
  const split = {
    ...structuredClone(source),
    id: planId,
    planId,
    workId: planId,
    title: changes.title?.trim() || `${source.title} — split`,
    description: changes.description ?? source.description,
    specification: changes.specification ?? source.specification,
    repository: changes.repository ?? source.repository,
    suggestedWorkType: changes.suggestedWorkType ?? source.suggestedWorkType,
    requirements: changes.requirements ?? structuredClone(source.requirements),
    acceptanceCriteria: changes.acceptanceCriteria ?? structuredClone(source.acceptanceCriteria),
    dependsOn: changes.dependsOn ?? [],
    blocking: changes.blocking ?? source.blocking,
    metadata: changes.metadata ?? structuredClone(source.metadata ?? {}),
    tasks: changes.tasks ?? [],
    jiraKey: null,
    initialJiraKey: null,
    jiraAliases: [],
    jiraIssueId: null,
    epicKey: null,
    parentMode: 'managed',
    idAuthority: null
  };
  epic.stories.push(split);
  breakdown.stories.push(split);
  const saved = await persistEpicStoryPlan(root, portfolio, initiative, breakdown, {
    event: 'epic_story_split',
    detail: `${sourcePlanId} -> ${planId}`
  });
  return {
    ...saved,
    sourcePlanId,
    story: saved.breakdown.stories.find((entry) => entry.planId === planId)
  };
}

export async function adoptEpicStory(root, initiativeId, issue, changes = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  assertStoryPlanningEditable(initiative);
  if (!issue?.key || !issue?.id) throw new SingularityFlowError('Adopting a Jira Story requires its key and stable issue ID.');
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  if (breakdown.stories.some((story) => story.jiraKey === issue.key)) {
    throw new SingularityFlowError(`Jira Story '${issue.key}' is already present in this Epic plan.`);
  }
  if (!changes.repository) throw new SingularityFlowError('Adopting a Jira Story requires a configured repository.');
  if (!changes.requirements?.length || !changes.acceptanceCriteria?.length) {
    throw new SingularityFlowError('Adopting a Jira Story requires at least one REQ-nnn and AC-nnn mapping.');
  }
  const epic = breakdown.epics[0];
  if (!epic) throw new SingularityFlowError(`Epic '${initiativeId}' has no planning Epic record.`);
  const planId = nextStoryPlanId(breakdown);
  const story = {
    id: planId,
    planId,
    workId: issue.key,
    title: changes.title?.trim() || issue.title || issue.key,
    description: changes.description ?? issue.description ?? '',
    specification: changes.specification ?? [
      `## Intended outcome`,
      '',
      issue.description || `Deliver ${issue.title || issue.key}.`,
      '',
      '## Acceptance expectations',
      '',
      ...(changes.acceptanceCriteria ?? []).map((criterion) => `- ${criterion}`)
    ].join('\n'),
    requirements: structuredClone(changes.requirements),
    acceptanceCriteria: structuredClone(changes.acceptanceCriteria),
    epicId: epic.id,
    repository: changes.repository,
    blocking: changes.blocking !== false,
    suggestedWorkType: changes.suggestedWorkType ?? 'feature',
    dependsOn: structuredClone(changes.dependsOn ?? []),
    consumesContracts: structuredClone(changes.consumesContracts ?? []),
    jiraKey: issue.key,
    initialJiraKey: issue.key,
    jiraAliases: [],
    jiraIssueId: String(issue.id),
    epicKey: issue.parent?.key ?? null,
    estimate: issue.storyPoints ?? null,
    idAuthority: 'jira',
    parentMode: 'external',
    metadata: {
      adoptedDirectly: 'true',
      originalParent: issue.parent?.key ?? 'unlinked',
      ...(changes.metadata ?? {})
    },
    tasks: (issue.subtasks ?? []).map((task, index) => ({
      id: `TASK-${String(index + 1).padStart(3, '0')}`,
      title: task.title ?? task.key,
      description: '',
      acceptanceCriteria: [],
      metadata: { adoptedDirectly: 'true' },
      jiraKey: task.key,
      jiraIssueId: task.id == null ? null : String(task.id)
    }))
  };
  epic.stories.push(story);
  breakdown.stories.push(story);
  const saved = await persistEpicStoryPlan(root, portfolio, initiative, breakdown, {
    event: 'epic_story_adopted',
    detail: `${issue.key} as ${planId}; Jira parent remains externally managed`
  });
  return {
    ...saved,
    story: saved.breakdown.stories.find((entry) => entry.planId === planId)
  };
}

function publicationReport(initiative, breakdown, attempt, jiraPlan) {
  const lines = [
    `# Story Publication Report — ${initiative.initiative.id}`,
    '',
    `- Completed: ${attempt.completedAt ?? nowIso()}`,
    `- Identity authority: ${initiative.lineage?.idAuthority ?? 'local'}`,
    `- Approved Planning generation: ${initiative.phases[EPIC_PHASES.planning]?.generation ?? 0}`,
    `- Jira write plan: ${jiraPlan?.sha256 ?? 'not applicable'}`,
    `- Materialization status: ${attempt.status}`,
    '',
    '## Published Stories',
    '',
    '| Plan ID | Jira / Work ID | Repository | Canonical branch | Seed commit | Tasks |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  for (const story of breakdown.stories) {
    const receipt = attempt.stories.find((entry) => entry.storyId === story.id);
    lines.push(`| ${story.planId} | ${story.jiraKey ?? story.workId} | ${story.repository} | ${story.workId} | ${receipt?.commit?.slice(0, 12) ?? 'unavailable'} | ${story.tasks?.length ?? 0} |`);
  }
  lines.push(
    '',
    'The planning workflow is complete. Developers now fetch a governed Story with',
    '`/sflow-story-fetch <JIRA-KEY>` and complete its repository workflow independently.',
    '',
    'Product Owner completion remains open until every blocking Story has a finalized review',
    'packet, exact-SHA checks, and approved spec-to-code conformance.',
    ''
  );
  return lines.join('\n');
}

/**
 * Jira/Git publication is a deterministic operation, not another authored phase.
 * Once every reviewed Story and canonical branch has a receipt, project the exact
 * plan and receipts into artifacts and finish the planning lifecycle automatically.
 */
export async function completeEpicPublication(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.resolution.profile !== 'epic-planning') {
    return { portfolio, initiative, completed: false, reason: 'not-epic-planning' };
  }
  const planning = initiative.phases[EPIC_PHASES.planning];
  const phase = initiative.phases[EPIC_PHASES.publish];
  if (planning?.status !== 'approved') throw new SingularityFlowError('Story publication requires the approved Planning package.');
  if (initiative.materialization?.status !== 'complete') {
    throw new SingularityFlowError('Story publication cannot complete until every Jira/Git Story receipt is present.');
  }
  if (phase.status === 'approved' && initiative.status === 'complete') {
    return { portfolio, initiative, completed: false, reason: 'already-complete' };
  }
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const attempt = initiative.materialization.attempts.at(-1);
  let jiraPlan = null;
  const jiraPlanSource = await secureInitiativePath(root, portfolio, initiativeId, 'context/jira/write-plan.yml', {
    label: `Epic '${initiativeId}' Jira write plan`,
    type: 'file'
  });
  if (jiraPlanSource.exists) jiraPlan = YAML.parse(await readFile(jiraPlanSource.absolute, 'utf8'));
  const planArtifact = {
    version: 1,
    epicId: initiativeId,
    authority: initiative.lineage?.idAuthority ?? 'local',
    approvedPlanning: {
      generation: planning.generation,
      outputs: Object.fromEntries(Object.values(planning.outputs).map((output) => [output.id, output.sha256]))
    },
    jira: jiraPlan
      ? { writePlanSha256: jiraPlan.sha256, operations: jiraPlan.operations, artifacts: jiraPlan.artifacts ?? [] }
      : { writePlanSha256: null, operations: [], artifacts: [] },
    stories: breakdown.stories.map((story) => {
      const receipt = attempt.stories.find((entry) => entry.storyId === story.id);
      return {
        planId: story.planId,
        jiraKey: story.jiraKey,
        workId: story.workId,
        repository: story.repository,
        canonicalBranch: story.workId,
        seedCommit: receipt?.commit ?? null,
        parentMode: story.parentMode ?? 'managed',
        metadata: story.metadata ?? {},
        tasks: story.tasks ?? []
      };
    })
  };
  const contents = {
    'jira-write-plan': YAML.stringify(planArtifact),
    'materialization-report': publicationReport(initiative, breakdown, attempt, jiraPlan)
  };
  const actor = identity(root);
  const generation = phase.generation + 1;
  for (const [outputId, content] of Object.entries(contents)) {
    const output = phase.outputs[outputId];
    if (!output) throw new SingularityFlowError(`Publish Stories phase has no '${outputId}' output.`);
    const target = await secureInitiativePath(root, portfolio, initiativeId, output.path, {
      label: `Epic publication output '${outputId}'`
    });
    await writeText(target.absolute, content);
    const current = await snapshot(target.absolute);
    Object.assign(output, {
      status: 'approved',
      generation,
      sha256: current.sha256,
      bytes: current.size,
      generatedBy: actor,
      generatedPersona: null,
      publishedAt: nowIso(),
      approvedAt: nowIso()
    });
  }
  const completedAt = nowIso();
  phase.generation = generation;
  phase.status = 'approved';
  phase.submittedAt = completedAt;
  phase.approvedAt = completedAt;
  initiative.currentPhase = null;
  initiative.status = 'complete';
  initiative.history.push({
    at: completedAt,
    actor: actor.email?.toLowerCase() ?? actor.name,
    event: 'epic_publication_completed',
    phase: EPIC_PHASES.publish,
    detail: `${breakdown.stories.length} Stories and canonical branches published; downstream delivery tracking opened`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, completed: true, generation, stories: breakdown.stories.length };
}
