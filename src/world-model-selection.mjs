/**
 * Which world-model content a phase receives, and at which tier.
 *
 * Two decisions used to be spread across the codebase and invisible at runtime, and together they
 * put 38 KB of grounding into a 67 KB prompt on a thirty-three-file repository.
 *
 * **Which views.** The set was `phase.worldModel.views ∪ agent.worldModelViews`, computed
 * identically in three places — `worldmodel.mjs`, `planning.mjs`, `initiative-context.mjs` — and
 * reported nowhere. A phase that carefully declared `[testing]` still received `architecture`
 * because the active agent happened to list it, and nothing on screen said so.
 *
 * **Which tier.** Every view is generated twice, as `views/<v>.md` and `views/<v>.brief.md`, and a
 * v2 manifest is *rejected* if the brief file is missing. Nothing ever selected one: the reader took
 * `manifest.views[view].path` unconditionally. Meanwhile `depth` — `light|quick|standard|deep` — was
 * declared per phase, validated, and used only to flavour the builder prompt, so two phases asking
 * for the same view at `quick` and at `deep` received byte-identical content.
 *
 * So the tier existed, was mandatory to produce, and was unreachable. This module makes `depth`
 * mean something at the point of consumption, which is the only place it could ever have mattered.
 */

/** How an agent's declared views combine with the phase's own. */
export const AGENT_VIEW_MODES = Object.freeze(['fallback', 'union']);

/** Depths a phase may declare, ordered from least to most content. */
export const DEPTHS = Object.freeze(['light', 'quick', 'standard', 'deep']);

/**
 * Resolve the views a phase will receive, keeping the provenance.
 *
 * `fallback` is the default: a phase that names its own views has stated a requirement, and an
 * agent's list is a default for phases that have not. `union` restores the previous behaviour for
 * anyone who wants it. The returned `origin` map is what lets a command show *why* a view is here,
 * which is the part that was missing.
 */
export function resolveViews(phaseViews = [], agentViews = [], { mode = 'fallback' } = {}) {
  if (!AGENT_VIEW_MODES.includes(mode)) {
    throw new TypeError(`worldModel.agentViews must be one of ${AGENT_VIEW_MODES.join(', ')}.`);
  }
  const declared = [...new Set(phaseViews.filter(Boolean))];
  const fromAgent = [...new Set(agentViews.filter(Boolean))];
  const useAgent = mode === 'union' || declared.length === 0;
  const views = useAgent ? [...new Set([...declared, ...fromAgent])] : declared;
  const origin = new Map();
  for (const view of views) {
    const inPhase = declared.includes(view);
    const inAgent = fromAgent.includes(view);
    origin.set(view, inPhase && inAgent ? 'phase+agent' : inPhase ? 'phase' : 'agent');
  }
  return { views, origin, mode, declared, fromAgent };
}

/**
 * The tier a phase's view is read at.
 *
 * A phase at `deep` has said it needs the detail. A phase at `light` or `quick` has said it does
 * not. `standard` — the default, and by far the most common — is the interesting case: the phase's
 * own first view is the subject it is working on and gets the full text; anything the agent or a
 * secondary declaration added is orientation, and the brief is what orientation is for.
 */
export function tierForView(view, { depth = 'standard', declared = [] } = {}) {
  if (depth === 'deep') return 'full';
  if (depth === 'light' || depth === 'quick') return 'brief';
  return declared[0] === view ? 'full' : 'brief';
}

/**
 * The core summary tier. `deep` reads the whole thing; everything else reads the brief.
 *
 * This was previously the string `'core/summary.md'` written literally at three call sites, so no
 * repository could ask for the brief core even though every model is required to produce one.
 */
export function tierForCore(depth = 'standard') {
  return depth === 'deep' ? 'full' : 'brief';
}

/** A stable, human-readable identity used by plans, manifests, receipts, and diagnostics. */
export function selectionId(selection) {
  if (selection?.kind === 'core') return `core/${selection.tier}`;
  if (selection?.kind === 'view') return `${selection.view}/${selection.tier}`;
  if (selection?.kind === 'task-guide') return `task-guide/${selection.taskSha256 ?? 'exact'}`;
  return 'unknown/unknown';
}

/**
 * Resolve the complete grounding requirement before any world-model file is read.
 *
 * This is intentionally pure. Build, compose, planning, initiatives, budget reporting, and
 * receipt verification must all be able to compare the same plan without consulting Git or the
 * filesystem. Keeping provenance on each selection also makes agent-added context visible.
 */
export function resolveGroundingPlan({
  phase,
  phaseViews = [],
  agentViews = [],
  agentViewMode = 'fallback',
  depth = 'standard',
  evidence = false,
  task = null,
  context = {}
} = {}) {
  if (!DEPTHS.includes(depth)) throw new TypeError(`world-model depth must be one of ${DEPTHS.join(', ')}.`);
  const resolved = resolveViews(phaseViews, agentViews, { mode: agentViewMode });
  const views = resolved.views.map((view, index) => {
    const tier = tierForView(view, { depth, declared: resolved.declared });
    const origin = resolved.origin.get(view);
    const primary = resolved.declared[0] === view;
    return {
      kind: 'view', view, tier, required: true, origin,
      reason: primary ? 'primary phase view' : origin === 'agent' ? 'agent orientation view' : 'secondary phase view',
      id: `${view}/${tier}`,
      order: index
    };
  });
  const normalizedTask = String(task ?? '').trim();
  return {
    phase: phase ?? null,
    depth,
    core: {
      kind: 'core', tier: tierForCore(depth), required: true,
      reason: 'shared repository orientation', id: `core/${tierForCore(depth)}`
    },
    views,
    selections: [{ kind: 'core', tier: tierForCore(depth), required: true }, ...views.map(({ view, tier, required, origin }) => ({ kind: 'view', view, tier, required, origin }))],
    includeDomains: context.includeDomains ?? 'matched',
    includeEvidence: Boolean(evidence || context.includeEvidence),
    taskGuide: normalizedTask ? { required: true, task: normalizedTask } : { required: false, task: null },
    agentViewMode: resolved.mode,
    declaredViews: resolved.declared,
    agentViews: resolved.fromAgent
  };
}
