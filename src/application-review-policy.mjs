/** ARA policy vocabulary, re-exported without adding another hot configuration dependency. */
export { ARA_VERSION, ARA_NAMESPACE, ARA_SURFACES, ARA_ACTIONS, ARA_READS, araFail, exactFields, reviewRelativePath, normalizeApplicationReview } from './code-delivery-policy.mjs';

/** Observed UI always strengthens a declared non-UI profile. Unknown auto scope stays unresolved. */
export function reviewApplicability(policy, paths) {
  const ui = paths.some(file => /\.(?:jsx|tsx|vue|svelte|html|css|scss)$/iu.test(file) && !/\.(?:test|spec)\./iu.test(file));
  const surface = ui ? 'web' : policy?.surface ?? 'auto';
  const resolved = surface !== 'auto';
  return { resolved, surface, reason: ui ? 'Observed user-facing source changes' : resolved ? 'Explicit adopted review profile' : 'Change surface requires an explicit review profile',
    dimensions: { visual: surface === 'web' ? 'pending' : resolved ? 'not-applicable' : 'pending', functional: 'pending' } };
}

/**
 * A visual step's coverage when the Story's declared surface has no screens, or null when a person decides as before
 * [CQF:REQ-035]. The same profile as app review, declared whether or not the work type adopts it (`applicationReview:
 * { mode: off, surface: library }` adopts nothing). Only a declared backend, cli, library or artifact surface rules the
 * step out, never a guess from the diff; a user-facing file a code step delivered (its recorded paths, no Git read)
 * brings it back. `applicability.words` is what the approver reads wherever visual coverage is shown.
 */
export function declaredVisualCoverage(workflow, { phase, profiles, mode, generation }) {
  const delivered = Object.values(workflow?.phases ?? {}).flatMap(step => step?.deliveryEvidence?.sourcePaths ?? []);
  const { surface, dimensions } = reviewApplicability(workflow?.resolution?.applicationReview, delivered);
  if (dimensions.visual !== 'not-applicable') return null;
  return { schemaVersion: 1, status: 'not-applicable', reason: 'declared-surface',
    applicability: { surface, declaredIn: 'applicationReview.surface', decidedBy: 'workflow configuration',
      words: `Visual check not applicable: this Story's workflow declares a ${surface} surface (applicationReview.surface), which has no screens, so no screen size needs a screenshot and nobody has to skip the step or rule out a screen size. A delivered .tsx, .jsx, .vue, .svelte, .html, .css or .scss file would make it apply again.` },
    mode, phase, generation, profiles, covered: [], uncovered: [], unclaimed: [], stale: [], duplicates: [], warnings: [], errors: [] };
}
