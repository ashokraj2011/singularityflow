import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { listEpicSources } from './epic-sources.mjs';
import { loadInitiativeBreakdown } from './initiative-repositories.mjs';
import { secureInitiativePath } from './initiative-state.mjs';

function sourceReference(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(SRC-[A-F0-9]{12})(?:[#@:](.+))$/i);
    return match ? { sourceId: match[1].toUpperCase(), locator: match[2].trim() } : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sourceId = String(value.sourceId ?? value.source ?? '').toUpperCase();
    const locator = String(value.locator ?? value.page ?? value.frame ?? value.section ?? '').trim();
    return sourceId && locator ? { sourceId, locator } : null;
  }
  return null;
}

function validateTraceItems(items, prefix, knownSources, errors) {
  if (!Array.isArray(items) || !items.length) {
    errors.push(`${prefix === 'REQ' ? 'requirements' : 'acceptanceCriteria'} must contain at least one traceability item`);
    return new Set();
  }
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !new RegExp(`^${prefix}-\\d{3,}$`).test(item.id)) {
      errors.push(`traceability item '${item?.id ?? 'unknown'}' must use ${prefix}-nnn`);
      continue;
    }
    if (ids.has(item.id)) errors.push(`duplicate traceability ID ${item.id}`);
    ids.add(item.id);
    if (!Array.isArray(item.sources) || !item.sources.length) {
      errors.push(`${item.id} has no pinned source citation`);
      continue;
    }
    for (const raw of item.sources) {
      const reference = sourceReference(raw);
      if (!reference) {
        errors.push(`${item.id} source citation must contain a source ID plus page, frame, or section locator`);
        continue;
      }
      if (!knownSources.has(reference.sourceId)) errors.push(`${item.id} cites unknown source ${reference.sourceId}`);
    }
  }
  return ids;
}

export async function verifyEpicTraceability(root, portfolio, initiative) {
  const errors = [];
  const warnings = [];
  const passes = [];
  if (initiative.resolution.profile !== 'epic-planning') return { errors, warnings, passes };
  const sources = await listEpicSources(root, initiative.initiative.id);
  const knownSources = new Set(sources.manifest.sources.map((entry) => entry.sourceId));
  const requirementsPhase = initiative.phases['epic-requirements'];
  const requirementsPrepared = requirementsPhase?.generation > 0
    || Object.values(requirementsPhase?.outputs ?? {}).some((output) => (output.generation ?? 0) > requirementsPhase.generation);
  if (requirementsPrepared) {
    const output = requirementsPhase.outputs['requirements-traceability'];
    const target = await secureInitiativePath(root, portfolio, initiative.initiative.id, output.path, {
      label: 'Epic requirements traceability',
      mustExist: true,
      type: 'file'
    });
    let parsed;
    try { parsed = YAML.parse(await readFile(target.absolute, 'utf8')); }
    catch (error) {
      errors.push(`requirements traceability YAML is invalid: ${error.message}`);
      return { errors, warnings, passes };
    }
    const requirementIds = validateTraceItems(parsed?.requirements, 'REQ', knownSources, errors);
    const acceptanceIds = validateTraceItems(parsed?.acceptanceCriteria, 'AC', knownSources, errors);
    for (const criterion of parsed?.acceptanceCriteria ?? []) {
      if (!Array.isArray(criterion.requirements) || !criterion.requirements.length) errors.push(`${criterion.id} must map to at least one REQ-nnn`);
      else for (const requirement of criterion.requirements) if (!requirementIds.has(requirement)) errors.push(`${criterion.id} maps to unknown requirement ${requirement}`);
    }
    if (!errors.length) passes.push(`${requirementIds.size} requirements and ${acceptanceIds.size} acceptance criteria cite pinned sources`);

    const planPhase = initiative.phases['epic-plan'];
    const planPrepared = planPhase?.generation > 0
      || Object.values(planPhase?.outputs ?? {}).some((output) => (output.generation ?? 0) > planPhase.generation);
    if (planPrepared) {
      const breakdown = await loadInitiativeBreakdown(root, portfolio, initiative.initiative.id);
      if (breakdown.version !== 2) errors.push('Epic Story plan must use breakdown version 2');
      const allocated = new Set();
      for (const story of breakdown.stories) {
        if (!story.requirements.length) errors.push(`${story.planId ?? story.id} has no REQ-nnn allocation`);
        if (!story.acceptanceCriteria.length) errors.push(`${story.planId ?? story.id} has no AC-nnn allocation`);
        for (const requirement of story.requirements) if (!requirementIds.has(requirement)) errors.push(`${story.planId ?? story.id} maps unknown requirement ${requirement}`);
        for (const criterion of story.acceptanceCriteria) {
          allocated.add(criterion);
          if (!acceptanceIds.has(criterion)) errors.push(`${story.planId ?? story.id} maps unknown acceptance criterion ${criterion}`);
        }
      }
      for (const criterion of acceptanceIds) if (!allocated.has(criterion)) errors.push(`${criterion} is not allocated to any planned Story`);
      if (!errors.length) passes.push(`${breakdown.stories.length} Stories trace to ${allocated.size}/${acceptanceIds.size} acceptance criteria`);
    }
  }
  return { errors, warnings, passes };
}
