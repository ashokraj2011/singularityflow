import {
  BUILTIN_VIEW_IDS, normalizeBuiltInViewReference
} from './world-model/registry/views.mjs';

export const WORLD_MODEL_VIEW_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const WORLD_MODEL_VIEW_REFERENCE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:@[1-9][0-9]*)?$/;

/**
 * The view names of the retired legacy-v3 World Model. They are not aliases for registered
 * contracts: a configuration that still names one keeps working without those views and is told
 * how to migrate (`singularity-flow wm migrate-views`).
 */
export const LEGACY_WORLD_MODEL_VIEW_IDS = Object.freeze([
  'business', 'architecture', 'development', 'testing', 'release', 'operations', 'security'
]);
const LEGACY_WORLD_MODEL_VIEW_ID_SET = new Set(LEGACY_WORLD_MODEL_VIEW_IDS);

/** Whether a view name belongs to the retired legacy-v3 vocabulary. */
export function isRetiredWorldModelView(view) {
  return LEGACY_WORLD_MODEL_VIEW_ID_SET.has(String(view ?? '').trim());
}

/**
 * The registered view that `wm migrate-views` writes in place of each retired name, as the packaged
 * configuration was migrated: release and operations have no successor and are removed.
 */
export const LEGACY_WORLD_MODEL_VIEW_SUCCESSORS = Object.freeze({
  business: 'biz.rules', architecture: 'arch.contracts', security: 'arch.contracts',
  development: 'dev.impact', testing: 'dev.impact', release: null, operations: null
});

const RETIRED_REFERENCES = new WeakMap();
const INJECTED_VIEW = /^views\/([a-z0-9]+(?:[.-][a-z0-9]+)*)\.md$/;

/**
 * Drop retired legacy-v3 view names (and the retired format and assignment settings) from a
 * workflow definition, in place, and return what was dropped as `{ source, value }`.
 *
 * The World Model is guidance, never authority: a repository that still names the retired views
 * keeps every command working. A phase or agent assigned only retired views gets no World Model,
 * and `doctor` names each dropped entry with the migration command.
 */
export function dropRetiredWorldModelReferences(definition) {
  if (!definition || typeof definition !== 'object') return [];
  const dropped = [];
  const keep = (views, source) => {
    if (!Array.isArray(views)) return views;
    return views.filter((view) => {
      if (!isRetiredWorldModelView(view)) return true;
      dropped.push(Object.freeze({ source, value: String(view).trim() }));
      return false;
    });
  };
  const worldModel = definition.worldModel;
  if (worldModel && typeof worldModel === 'object' && !Array.isArray(worldModel)) {
    if (worldModel.format === 'legacy-v3') {
      dropped.push(Object.freeze({ source: 'worldModel.format', value: 'legacy-v3' }));
      delete worldModel.format;
    }
    if (worldModel.v4 && typeof worldModel.v4 === 'object' && worldModel.v4.legacyAssignments === 'inherit-configured') {
      dropped.push(Object.freeze({ source: 'worldModel.v4.legacyAssignments', value: 'inherit-configured' }));
      worldModel.v4.legacyAssignments = 'strict';
    }
    if (Array.isArray(worldModel.views)) {
      const kept = keep(worldModel.views, 'worldModel.views');
      // Every listed view was retired: the repository has the registered views' defaults.
      if (kept.length) worldModel.views = kept;
      else delete worldModel.views;
    }
    if (Array.isArray(worldModel.injection?.rules)) {
      worldModel.injection.rules = worldModel.injection.rules.filter((rule, index) => {
        if (!Array.isArray(rule?.include)) return true;
        const include = rule.include.filter((entry) => {
          const view = String(entry).match(INJECTED_VIEW)?.[1]?.replace(/\.(?:brief|full)$/, '');
          if (!view || !isRetiredWorldModelView(view)) return true;
          dropped.push(Object.freeze({ source: `world-model injection rule ${index + 1}`, value: String(entry) }));
          return false;
        });
        if (include.length === rule.include.length) return true;
        rule.include = include;
        return include.length > 0;
      });
    }
  }
  for (const [phaseId, phase] of Object.entries(definition.phases ?? {})) {
    if (Array.isArray(phase?.worldModel?.views)) phase.worldModel.views = keep(phase.worldModel.views, `phase '${phaseId}'`);
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes ?? {})) {
    for (const [phaseId, override] of Object.entries(workType?.phaseOverrides ?? {})) {
      if (Array.isArray(override?.worldModel?.views)) {
        override.worldModel.views = keep(override.worldModel.views, `workflow '${workTypeId}' phase '${phaseId}' override`);
      }
    }
  }
  // Agents are shared, possibly frozen, catalog entries: a changed agent is replaced by a copy.
  const agentCopies = new Map();
  for (const [agentId, agent] of Object.entries(definition.agents ?? {})) {
    if (!Array.isArray(agent?.worldModelViews) || !agent.worldModelViews.some(isRetiredWorldModelView)) continue;
    const copy = { ...agent, worldModelViews: keep(agent.worldModelViews, `agent '${agentId}' prompt`) };
    agentCopies.set(agent, copy);
    definition.agents[agentId] = copy;
  }
  if (agentCopies.size && Array.isArray(definition.agentCatalog)) {
    definition.agentCatalog = definition.agentCatalog.map((agent) => agentCopies.get(agent) ?? agent);
  }
  if (dropped.length) RETIRED_REFERENCES.set(definition, [...(RETIRED_REFERENCES.get(definition) ?? []), ...dropped]);
  return dropped;
}

/** What `dropRetiredWorldModelReferences` dropped from this exact definition, for diagnostics. */
export function retiredWorldModelReferences(definition) {
  return definition && typeof definition === 'object' ? [...(RETIRED_REFERENCES.get(definition) ?? [])] : [];
}

/** A phase or agent assignment, trimmed; every entry must be a registered view ID. */
export function worldModelAssignmentViews(views = []) {
  return Array.isArray(views) ? views.map((view) => String(view).trim()).filter(Boolean) : [];
}

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
  const values = definition?.worldModel?.views ?? BUILTIN_VIEW_IDS;
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
    for (const view of worldModelAssignmentViews(phase.worldModel?.views)) addReference(references, definition, view, `phase '${phaseId}'`);
  }
  for (const [agentId, agent] of Object.entries(definition.agents ?? {})) {
    for (const view of worldModelAssignmentViews(agent.worldModelViews)) addReference(references, definition, view, `agent '${agentId}' prompt`);
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes ?? {})) {
    for (const [phaseId, override] of Object.entries(workType.phaseOverrides ?? {})) {
      for (const view of worldModelAssignmentViews(override.worldModel?.views)) addReference(references, definition, view, `workflow '${workTypeId}' phase '${phaseId}' override`);
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
  const prompted = promptViews == null ? [] : [...promptViews];
  const inferred = [
    ...structuredWorldModelViewReferences(definition).keys(),
    ...prompted.map((view) => worldModelViewIdentity(definition, view)?.id).filter(Boolean)
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
  const logicalViews = (views) => worldModelAssignmentViews(views).flatMap((view) => {
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
