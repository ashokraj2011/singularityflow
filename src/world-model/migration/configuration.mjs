/** Explicit, configuration-only v3 → v4 transition; never upgrades prose into facts. */
import { BUILTIN_VIEW_REFERENCES, normalizeBuiltInViewReference } from '../registry/views.mjs';
import { LEGACY_WORLD_MODEL_VIEW_IDS } from '../../world-model-views.mjs';
import { SingularityFlowError } from '../../util.mjs';

const legacy = new Set(LEGACY_WORLD_MODEL_VIEW_IDS);

function catalogKind(views, label) {
  if (!Array.isArray(views) || !views.length || views.some(view => typeof view !== 'string')
      || new Set(views).size !== views.length) {
    throw new SingularityFlowError(`${label} must be a non-empty, unique view list.`, {
      code: 'WMB_MIGRATION_CATALOG_INVALID'
    });
  }
  const old = views.filter(view => legacy.has(view));
  if (old.length === views.length) return 'legacy';
  if (old.length) throw new SingularityFlowError(
    `${label} mixes legacy and registered views. Review that assignment before migration.`, {
      code: 'WMB_VIEW_ASSIGNMENT_MIXED'
    }
  );
  for (const view of views) normalizeBuiltInViewReference(view);
  return 'registered';
}

/** Pure plan over authored data. Custom policy, scope, identity and authority are preserved. */
export function planWorldModelConfigurationMigration(definition, capabilities = null) {
  const value = structuredClone(definition);
  const before = value.worldModel ?? {};
  const fromFormat = before.format ?? 'legacy-v3';
  if (!['legacy-v3', 'registered-v4'].includes(fromFormat)) throw new SingularityFlowError(
    `Cannot migrate unknown World Model format '${fromFormat}'.`, { code: 'WMB_FORMAT_INVALID' }
  );
  const currentViews = before.views ?? (fromFormat === 'legacy-v3'
    ? LEGACY_WORLD_MODEL_VIEW_IDS : BUILTIN_VIEW_REFERENCES);
  const kind = catalogKind(currentViews, 'worldModel.views');
  if (fromFormat === 'registered-v4' && kind === 'legacy') throw new SingularityFlowError(
    'The registered-v4 repository catalog still contains legacy names. Repair the approved catalog before migration.',
    { code: 'WMB_MIGRATION_CATALOG_INVALID' }
  );
  if (fromFormat === 'legacy-v3') {
    value.worldModel = {
      ...before,
      format: 'registered-v4',
      views: kind === 'legacy' ? [...BUILTIN_VIEW_REFERENCES] : [...currentViews],
      v4: {
        composer: 'deterministic', consumer: 'developer', cachePolicy: 'reuse-valid',
        ...before.v4,
        // Known legacy phase/agent/initiative assignments inherit this exact catalog; no aliases.
        legacyAssignments: 'inherit-configured'
      }
    };
  }
  const views = value.worldModel?.views ?? [...BUILTIN_VIEW_REFERENCES];
  const viewIds = views.map(view => normalizeBuiltInViewReference(view).viewId);
  const migratedCapabilities = structuredClone(capabilities);
  const capabilityAssignments = [];
  for (const [id, capability] of Object.entries(migratedCapabilities?.capabilities ?? {})) {
    const assigned = capability.policy?.requiredWorldModelViews;
    if (assigned == null || (Array.isArray(assigned) && !assigned.length)) continue;
    const assignmentKind = catalogKind(assigned, `Capability '${id}' requiredWorldModelViews`);
    if (assignmentKind === 'legacy') {
      capability.policy.requiredWorldModelViews = [...viewIds];
      capabilityAssignments.push({ capability: id, before: [...assigned], after: [...viewIds] });
    } else {
      for (const view of assigned) if (!viewIds.includes(normalizeBuiltInViewReference(view).viewId)) {
        throw new SingularityFlowError(
          `Capability '${id}' requires undeclared registered view '${view}'. Review its catalog before migration.`,
          { code: 'WMB_MIGRATION_CAPABILITY_VIEW_UNDECLARED' }
        );
      }
    }
  }
  return {
    definition: value,
    capabilities: migratedCapabilities,
    report: {
      fromFormat, targetFormat: 'registered-v4', views: [...views],
      legacyAssignments: value.worldModel?.v4?.legacyAssignments ?? 'strict',
      capabilities: Object.keys(migratedCapabilities?.capabilities ?? {}).sort(),
      capabilityAssignments,
      historicalArtifacts: 'preserved', storiesRepinned: false,
      // A configuration migration does not assert that any source analysis has been performed.
      rebuildRequired: fromFormat !== 'registered-v4' || capabilityAssignments.length > 0
    }
  };
}
