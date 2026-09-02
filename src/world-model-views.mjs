import {
  BUILTIN_VIEW_IDS, normalizeBuiltInViewReference
} from './world-model/registry/views.mjs';

export const WORLD_MODEL_VIEW_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const WORLD_MODEL_VIEW_REFERENCE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:@[1-9][0-9]*)?$/;

/**
 * A registered-v4 contract has two deliberately different representations:
 *
 * - `id` is the logical name used by phases and agent Markdown. Those readers pre-date versioned
 *   contracts and must never be handed `@4`.
 * - `reference` is the exact installed contract retained by the repository-level configuration.
 *
 * Keeping the join here prevents the Configuration Center, instruction designer, and validation
 * code from each inventing a different interpretation of `dev.impact` versus `dev.impact@4`.
 */
export function worldModelViewIdentity(definition, value) {
  const raw = String(value ?? '').trim();
  if (!raw || !WORLD_MODEL_VIEW_REFERENCE.test(raw)) return null;
  if (definition?.worldModel?.format !== 'registered-v4') {
    return WORLD_MODEL_VIEW_ID.test(raw)
      ? Object.freeze({ id: raw, reference: raw, version: null })
      : null;
  }
  try {
    const normalized = normalizeBuiltInViewReference(raw);
    return Object.freeze({
      id: normalized.viewId,
      reference: normalized.reference,
      version: normalized.version
    });
  } catch {
    return null;
  }
}

function configuredContractById(definition) {
  const contracts = new Map();
  const values = definition?.worldModel?.views
    ?? (definition?.worldModel?.format === 'registered-v4' ? BUILTIN_VIEW_IDS : []);
  for (const value of values) {
    const identity = worldModelViewIdentity(definition, value);
    if (identity) contracts.set(identity.id, identity);
  }
  return contracts;
}

function addReference(index, definition, view, reference) {
  const raw = String(view ?? '').trim();
  if (!WORLD_MODEL_VIEW_REFERENCE.test(raw)) return;
  const identity = worldModelViewIdentity(definition, raw);
  // Retain syntactically shaped but unregistered refs so validation can reject them with their
  // source. Silently dropping one here would turn a bad phase/agent assignment into an apparently
  // unused configuration entry.
  const id = identity?.id ?? raw;
  const references = index.get(id) ?? [];
  if (!references.includes(reference)) references.push(reference);
  index.set(id, references);
}

export function markdownWorldModelViews(content) {
  const views = new Set();
  for (const match of String(content ?? '').matchAll(/(?:^|[^a-zA-Z0-9_.-])views\/([a-z0-9]+(?:[.-][a-z0-9]+)*)\.md\b/g)) {
    // Legacy tier artifacts use `business.brief.md`/`business.full.md`; the tier is not part of
    // the view ID. Registered IDs may contain other dots (`dev.impact.md`) and remain intact.
    views.add(match[1].replace(/\.(?:brief|full)$/, ''));
  }
  return [...views].sort();
}

export function structuredWorldModelViewReferences(definition) {
  const references = new Map();
  for (const [phaseId, phase] of Object.entries(definition.phases ?? {})) {
    for (const view of phase.worldModel?.views ?? []) addReference(references, definition, view, `phase '${phaseId}'`);
  }
  for (const [agentId, agent] of Object.entries(definition.agents ?? {})) {
    for (const view of agent.worldModelViews ?? []) addReference(references, definition, view, `agent '${agentId}' prompt`);
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes ?? {})) {
    for (const [phaseId, override] of Object.entries(workType.phaseOverrides ?? {})) {
      for (const view of override.worldModel?.views ?? []) addReference(references, definition, view, `workflow '${workTypeId}' phase '${phaseId}' override`);
    }
  }
  for (const [index, rule] of (definition.worldModel?.injection?.rules ?? []).entries()) {
    for (const include of rule.include ?? []) {
      const match = String(include).match(/^views\/([a-z0-9]+(?:[.-][a-z0-9]+)*)\.md$/);
      if (match) addReference(references, definition, match[1], `world-model injection rule ${index + 1}`);
    }
  }
  return references;
}

/** Exact contract metadata for repository configuration and diagnostics. */
export function worldModelViewContractCatalog(definition, promptViews = []) {
  const configured = configuredContractById(definition);
  const ordered = [...configured.values()];
  const present = new Set(configured.keys());
  const inferred = [
    ...structuredWorldModelViewReferences(definition).keys(),
    ...promptViews.map((view) => worldModelViewIdentity(definition, view)?.id).filter(Boolean)
  ].filter((id) => !present.has(id)).sort();
  for (const id of inferred) {
    if (present.has(id)) continue;
    const active = worldModelViewIdentity(definition, id);
    if (active) {
      ordered.push(active);
      present.add(id);
    }
  }
  return ordered;
}

export function worldModelViewCatalog(definition, promptViews = []) {
  return worldModelViewContractCatalog(definition, promptViews).map((entry) => entry.id);
}

export function worldModelViewReferences(definition, view, promptReferences = []) {
  const identity = worldModelViewIdentity(definition, view);
  return [...(structuredWorldModelViewReferences(definition).get(identity?.id ?? view) ?? []), ...promptReferences];
}

/**
 * Effective workflow → phase → view routing for human and machine readers.
 *
 * The resolver already treats a phase declaration as the default, a work-type view list as a full
 * replacement (including `[]`), and an intelligence profile set to `off` as authoritative. Project
 * that join once in the engine so UI clients never have to reproduce workflow semantics.
 */
export function worldModelWorkflowViewUsage(definition) {
  const phases = definition?.phases ?? {};
  const logicalViews = (views) => views.flatMap((view) => {
    const identity = worldModelViewIdentity(definition, view);
    return identity ? [identity.id] : [];
  });
  return Object.entries(definition?.workTypes ?? {}).map(([workTypeId, workType]) => {
    const disabled = workType?.intelligence?.worldModel === 'off';
    return {
      id: workTypeId,
      label: workType?.label ?? workTypeId,
      mode: disabled ? 'off' : String(workType?.intelligence?.worldModel ?? 'inherit'),
      phases: (workType?.phases ?? []).map((phaseId) => {
        const base = phases[phaseId] ?? {};
        const override = workType?.phaseOverrides?.[phaseId]?.worldModel;
        const overridden = Array.isArray(override?.views);
        return {
          id: phaseId,
          label: base.label ?? phaseId,
          // Agent Markdown and workflow phase policy consume logical IDs, never exact `@version`
          // contract references. The repository catalog retains the exact reference separately.
          views: disabled ? [] : logicalViews(overridden ? override.views : base.worldModel?.views ?? []),
          depth: String(override?.depth ?? base.worldModel?.depth ?? 'standard'),
          source: disabled ? 'disabled' : overridden ? 'workflow-override' : 'shared-phase'
        };
      })
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
}

export function addWorldModelView(definition, view) {
  const id = String(view ?? '').trim();
  if (!WORLD_MODEL_VIEW_ID.test(id)) throw new Error('World-model view ID must be lower-case kebab-case.');
  const next = structuredClone(definition);
  next.worldModel ??= {};
  const configured = next.worldModel.views ?? worldModelViewContractCatalog(next)
    .map((entry) => entry.reference);
  if (worldModelViewCatalog(next).includes(id)) throw new Error(`World-model view '${id}' already exists.`);
  const identity = worldModelViewIdentity(next, id);
  if (!identity) throw new Error(`World-model view '${id}' is not an installed active registered contract.`);
  next.worldModel.views = [...configured, identity.reference];
  return next;
}

export function removeWorldModelView(definition, view, promptReferences = []) {
  const configured = worldModelViewCatalog(definition);
  const identity = worldModelViewIdentity(definition, view);
  const id = identity?.id ?? String(view ?? '').trim();
  if (!configured.includes(id)) throw new Error(`World-model view '${id}' does not exist.`);
  const references = worldModelViewReferences(definition, id, promptReferences);
  if (references.length) throw new Error(`World-model view '${view}' is still used by ${references.join(', ')}. Remove those references first.`);
  const next = structuredClone(definition);
  next.worldModel ??= {};
  next.worldModel.views = (definition.worldModel?.views ?? []).filter(
    (entry) => worldModelViewIdentity(definition, entry)?.id !== id
  );
  return next;
}
