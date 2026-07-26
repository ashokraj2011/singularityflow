import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadDefinition } from './config.mjs';
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

export async function updateEpicStory(root, initiativeId, planId, changes = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const phase = initiative.phases[EPIC_PHASES.planning];
  if (!phase) throw new SingularityFlowError('Epic does not configure the Planning package.');
  if (!['in_progress', 'approved'].includes(phase.status)) {
    throw new SingularityFlowError(`Story edits are available when Planning is in progress or approved; it is '${phase.status}'.`);
  }
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const story = breakdown.stories.find((entry) => entry.planId === planId);
  if (!story) throw new SingularityFlowError(`Epic '${initiativeId}' has no planned Story '${planId}'.`);
  const allowed = new Set([
    'title', 'description', 'repository', 'suggestedWorkType', 'blocking',
    'requirements', 'acceptanceCriteria', 'dependsOn', 'specification'
  ]);
  const unexpected = Object.keys(changes).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new SingularityFlowError(`Unsupported Story fields: ${unexpected.join(', ')}.`);
  Object.assign(story, structuredClone(changes));
  validateInitiativeBreakdown(breakdown, portfolio);
  const document = YAML.stringify(initiativeBreakdownDocument(breakdown));
  const breakdownTarget = await secureInitiativePath(root, portfolio, initiativeId, 'breakdown.yml', {
    label: `Epic '${initiativeId}' Story plan`,
    mustExist: true,
    type: 'file'
  });
  await writeText(breakdownTarget.absolute, document);
  const output = planningOutput(initiative, 'story-plan');
  const outputTarget = await secureInitiativePath(root, portfolio, initiativeId, output.path, {
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
  const publishPhase = initiative.phases[EPIC_PHASES.publish];
  if (publishPhase) {
    publishPhase.status = 'not_started';
    publishPhase.startedAt = null;
    for (const approval of publishPhase.approvals ?? []) {
      if (!approval.invalidatedAt) approval.invalidatedAt = invalidatedAt;
    }
  }
  initiative.history.push({
    at: invalidatedAt,
    actor: 'singularity-flow',
    event: 'epic_story_updated',
    phase: EPIC_PHASES.planning,
    detail: `${planId}: ${Object.keys(changes).join(', ')}`
  });
  await saveInitiative(root, portfolio, initiative);
  const specifications = await prepareEpicStorySpecifications(root, initiativeId);
  const fresh = await loadInitiative(root, initiativeId);
  return { ...fresh, story, specifications, changed: Object.keys(changes) };
}
