/**
 * The changed paths the final code approval would refuse as unclaimed, found while the generation
 * is still open. Approval accepts a changed application path only when a planned clause names it in
 * its Expected paths or planned tests, or the plan lists it under `## Supporting files`; otherwise
 * it refuses the phase, and that used to surface only after submission. Read-only and bounded, it
 * never throws: draft-check and prepublish carry its results as non-blocking advisories, and
 * approval keeps its own exact check over the submitted revision.
 */
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { phaseRequiresCodeDelivery } from './delivery-evidence.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import {
  loadBoundActiveSpecRecords, mergePlannedClaimRecords, normalizeSpecPolicy, plannedSupportingFiles
} from './specifications.mjs';
import { workDir } from './state-stores.mjs';
import { posix } from './util.mjs';

const MAXIMUM_ADVISORIES = 50;

function excluded(candidate, excludes) {
  return excludes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix.replace(/\/$/, '')}/`));
}

/**
 * `{ coverage, advisories }`. `coverage.status` is `ready` (every changed path is accounted for),
 * `unclaimed` (some are not), `not-applicable` (this phase is not the final code approval, or
 * coverage is not enforced) or `unavailable` (the plan or the change could not be read).
 */
export async function inspectUnclaimedChangedPaths(root, config, workflow, phase) {
  try {
    const policy = normalizeSpecPolicy(workflow.resolution?.spec ?? config.spec ?? {});
    const codePhases = (workflow.phaseOrder ?? []).filter((id) => phaseRequiresCodeDelivery(workflow.phases?.[id]));
    if (policy.coverage !== 'enforce' || workflow.resolution?.plannedClaims?.mode !== 'required'
        || !phaseRequiresCodeDelivery(phase) || codePhases.at(-1) !== phase.id) {
      return { coverage: { status: 'not-applicable', unclaimed: 0, blocking: false }, advisories: [] };
    }
    // Only the planned maps matter here; the open generation's own records are not committed yet.
    const records = await loadBoundActiveSpecRecords(
      root, workDir(root, config, workflow.workItem.id), workflow, policy, { requireCommitted: false }
    );
    const planned = mergePlannedClaimRecords(records.planned ?? []);
    const accounted = new Set([
      ...Object.values(planned).flatMap((claim) => [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]),
      ...plannedSupportingFiles(records.planned ?? [])
    ]);
    const baseCommit = workflow.workItem?.baseCommit
      ?? workflow.phases?.[workflow.phaseOrder?.[0]]?.sourceCommit ?? null;
    if (!baseCommit) return { coverage: { status: 'unavailable', reason: 'story-base-unknown', unclaimed: 0, blocking: false }, advisories: [] };
    const pathContext = applicationPathContext(config, workflow);
    const changeSet = await buildRepositoryChangeSet(root, { baseCommit });
    const changed = [...new Set(changeSet.entries.flatMap((entry) => [entry.newPath, entry.oldPath]).filter(Boolean).map(posix))]
      .filter((candidate) => isApplicationPath(candidate, pathContext) && !excluded(candidate, policy.excludes))
      .sort();
    const unclaimed = changed.filter((candidate) => !accounted.has(candidate));
    const advisories = unclaimed.slice(0, MAXIMUM_ADVISORIES).map((candidate) => Object.freeze({
      code: 'spec.coverage.unclaimed-path', category: 'coverage', blocking: false,
      path: candidate, line: null, value: candidate,
      message: `Changed path ${candidate} is in no planned clause's Expected paths or tests and not under the plan's Supporting files; approving this phase would refuse it.`
    }));
    return {
      coverage: Object.freeze({
        status: unclaimed.length ? 'unclaimed' : 'ready', changedPaths: changed.length, unclaimed: unclaimed.length,
        omitted: unclaimed.length - advisories.length, blocking: false
      }),
      advisories: Object.freeze(advisories)
    };
  } catch (error) {
    return { coverage: { status: 'unavailable', reason: error?.code ?? 'inspection-failed', unclaimed: 0, blocking: false }, advisories: [] };
  }
}
