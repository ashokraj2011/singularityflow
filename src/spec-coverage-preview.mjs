/**
 * The changed paths the final code approval would refuse as unclaimed, found while the generation
 * is still open. Approval accepts a changed application path only when a planned clause names it in
 * its Expected paths or planned tests, or the plan lists it under `## Supporting files`; otherwise
 * it refuses the phase, and that used to surface only after submission. Read-only and bounded, it
 * never throws: draft-check and prepublish carry its results as non-blocking advisories, and
 * approval keeps its own exact check over the submitted revision.
 */
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { accountedAmendmentPaths } from './plan-amendments.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import {
  deriveObservedClaimMap, evaluateSpecCoverage, loadBoundActiveSpecRecords, mergePlannedClaimRecords,
  normalizeSpecPolicy, plannedSupportingFiles, plannedProductSourcePaths
} from './specifications.mjs';
import { workDir } from './state-stores.mjs';
import { posix, SingularityFlowError } from './util.mjs';

/** Check the actual editable candidate, before tests, publication or submission consume it. */
export async function assertCandidateSpecificationCoverage(root, config, workflow, phase, delivery) {
  try { return await assertStrictCandidateSpecificationCoverage(root, config, workflow, phase, delivery); }
  catch (error) {
    if (error.code !== 'SPEC_COVERAGE_INCOMPLETE') throw error;
    const { qualityRiskStatus } = await import('./phase-quality-risk.mjs');
    const risk = await qualityRiskStatus(root, config, workflow, phase, error, { transition: 'publish', candidate: delivery });
    if (risk.excepted) return { ...error.details.coverage, complete: false, acceptedRisk: risk };
    error.details = { ...error.details, qualityRisk: risk };
    throw error;
  }
}

export async function assertStrictCandidateSpecificationCoverage(root, config, workflow, phase, delivery) {
  const policy = normalizeSpecPolicy(workflow.resolution?.spec ?? config.spec ?? {});
  if (policy.coverage !== 'enforce' || workflow.resolution?.plannedClaims?.mode !== 'required') return null;
  const codePhases = workflow.phaseOrder.filter((id) => phaseRequiresCodeDelivery(workflow.phases[id]));
  const final = codePhases.at(-1) === phase.id;
  const records = await loadBoundActiveSpecRecords(root, workDir(root, config, workflow.workItem.id), workflow, policy,
    { requireCommitted: false, throughPhase: final ? null : phase.id, excludeObservedPhase: phase.id });
  const owner = workflow.resolution.plannedClaims.owners[phase.id];
  const planned = mergePlannedClaimRecords(records.planned.filter((record) => record.phase === owner));
  const allocated = Object.fromEntries(Object.entries(planned)
    .filter(([, claim]) => !claim.steps?.length || claim.steps.includes(phase.id)));
  const observed = deriveObservedClaimMap(allocated, {
    ...delivery, fulfillment: { obligations: delivery.fulfillment ?? [] },
    traceability: { bindings: delivery.acceptanceCriteria?.bindings ?? [], sourceBindings: delivery.sourceBindings?.bindings ?? [] }
  }, { policy, requireSourceBindings: workflow.resolution?.codeDelivery?.traceability?.sourceBindings === 'enforce' });
  const changed = [...new Set(delivery.changeSet.entries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))]
    .filter((candidate) => isApplicationPath(candidate, applicationPathContext(config, workflow)));
  const coverage = evaluateSpecCoverage({ ...records, observed: [
    ...records.observed.filter((record) => record.phase !== phase.id), { ...observed, phase: phase.id }
  ] }, changed, policy, { workflow });
  const open = coverage.unimplemented.filter((id) => final || allocated[id]);
  const claimGaps = open.map(clauseId => {
    const plan = allocated[clauseId];
    const claim = observed.claims[clauseId];
    const expected = plan && (!plan.fulfillment || ['new', 'modified'].includes(plan.fulfillment))
      ? plannedProductSourcePaths(plan) : plan?.expectedPaths ?? [];
    const missingSourcePaths = expected.filter(candidate => !(claim?.observedPaths ?? []).includes(candidate));
    const sourcePaths = new Set([...(delivery.sourcePaths ?? []), ...(delivery.deletedSourcePaths ?? [])]);
    return { clauseId, verdict: claim?.verdict ?? 'missing',
      missingSourcePaths: missingSourcePaths.filter(candidate => !sourcePaths.has(candidate)),
      missingSourceBindings: missingSourcePaths.filter(candidate => sourcePaths.has(candidate)),
      missingTestPaths: (plan?.tests ?? []).filter(candidate => !(claim?.testResults ?? []).includes(candidate)) };
  });
  const gapText = claimGaps.map(gap => `${gap.clauseId} (${[
    ...(gap.missingSourcePaths.length ? [`source paths: ${gap.missingSourcePaths.join(', ')}`] : []),
    ...(gap.missingSourceBindings.length ? [`source bindings: ${gap.missingSourceBindings.join(', ')}`] : []),
    ...(gap.missingTestPaths.length ? [`test paths/bindings: ${gap.missingTestPaths.join(', ')}`] : [])
  ].join('; ') || gap.verdict})`).join('; ');
  if (open.length || (final && coverage.invalidEvidence.length)) throw new SingularityFlowError(
    `Phase '${phase.id}' has incomplete planned delivery before publication: ${gapText || coverage.invalidEvidence.join('; ')}. `
    + 'Inspect these exact source/test obligations while this generation is editable. Add a binding only where the approved behavior is actually implemented; an incorrect location needs a reviewed plan correction. Preserve application code and approved maps. A screenshot is fulfillment evidence, not an executable test or an automatic visual pass.',
    { code: 'SPEC_COVERAGE_INCOMPLETE', details: { workId: workflow.workItem.id, phase: phase.id,
      coverage, claimGaps, planningOwner: owner, diagnosticCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json` } });
  return coverage;
}

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
      root, workDir(root, config, workflow.workItem.id), workflow, policy, { requireCommitted: false, plannedOnly: true }
    );
    const planned = mergePlannedClaimRecords(records.planned ?? []);
    const accounted = new Set([
      ...Object.values(planned).flatMap((claim) => [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]),
      ...plannedSupportingFiles(records.planned ?? []),
      ...accountedAmendmentPaths(records.planned ?? [])
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
