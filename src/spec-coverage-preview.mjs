/**
 * The changed paths the final code approval would refuse as unclaimed, found while the generation
 * is still open. Approval accepts a changed application path only when a planned clause names it in
 * its Expected paths or planned tests, or the plan lists it under `## Supporting files`; otherwise
 * it refuses the phase, and that used to surface only after submission. Read-only and bounded, it
 * never throws: draft-check and prepublish carry its results as non-blocking advisories, and
 * approval keeps its own exact check over the submitted revision.
 */
import { applicationPathContext, isApplicationChangeEntry, isApplicationPath } from './application-paths.mjs';
import { accountedAmendmentPaths } from './plan-amendments.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import {
  codeCoverageEnforcement, deriveObservedClaimMap, evaluateSpecCoverage, loadBoundActiveSpecRecords, mergePlannedClaimRecords,
  normalizeSpecPolicy, plannedSupportingFiles, plannedProductSourcePaths
} from './specifications.mjs';
import { isConfigurationPath } from './configuration-paths.mjs';
import { workDir } from './story-paths.mjs';
import { issueNamesClause, OPEN_UPSTREAM_ISSUE_STATUSES, raiseUpstreamIssueRoute, settledUpstreamClauses, upstreamIssueStates } from './upstream-routes.mjs';
import { posix, SingularityFlowError } from './util.mjs';

/**
 * The open upstream issues that name a clause still without delivery, and whether they name all of
 * them. A clause an open issue names waits on that issue's decision by the earlier step's approvers,
 * never on this step's code (office, 2026-10-27: UPI-001 against planning named the clause, and every
 * route still sent the coder back to /sf-code).
 */
export function upstreamDecisionFor(workflow, clauseIds) {
  const issues = upstreamIssueStates(workflow).filter((state) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(state.status))
    .map(({ issue }) => ({ id: issue.id, phase: issue.phase,
      clauses: clauseIds.filter((clauseId) => issueNamesClause(`${issue.about ?? ''} ${issue.problem ?? ''}`, clauseId)) }))
    .filter((entry) => entry.clauses.length);
  if (!issues.length) return null;
  const waiting = new Set(issues.flatMap((entry) => entry.clauses));
  return { issues, complete: clauseIds.length > 0 && clauseIds.every((clauseId) => waiting.has(clauseId)) };
}

/**
 * What a coverage refusal says and carries for the clauses open upstream issues name: which clauses
 * wait on which issue and, when every one does, the decision list as its next action. The same at
 * publication, submission and approval [PHR:REQ-003].
 */
export function upstreamWaiting(workflow, upstreamDecision) {
  if (!upstreamDecision) return { text: '', details: {} };
  const phases = [...new Set(upstreamDecision.issues.map((entry) => entry.phase))].join(' and ');
  const text = ` ${upstreamDecision.issues.map((entry) => `${entry.id} (raised against ${entry.phase}) names ${entry.clauses.join(', ')}`).join('; ')}: `
    + `${upstreamDecision.complete ? 'every clause listed here waits' : 'those clauses wait only'} on that decision by ${phases}'s approvers, not on this step's code`
    + `${upstreamDecision.complete ? '; they decide it in the decision list (singularity-flow decisions ' + workflow.workItem.id + ').' : '; deliver the others.'}`;
  return { text, details: { upstreamDecision,
    // Every gap waits on a person's decision: the decision list is the way through, for every surface.
    ...(upstreamDecision.complete ? { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id} --json`, skill: '/sf-decide',
      label: `${phases}'s approvers decide ${upstreamDecision.issues.map((entry) => entry.id).join(', ')} (return, plan correction, accepted risk or dismissal) in the decision list.` } } : {}) } };
}

/**
 * The plan's own corrections for clauses the code step did not deliver where the plan put them, and
 * the upstream issue to the plan's approvers [PHR:REQ-003]. A coder cannot move a planned location;
 * an approver of the plan records `decision plan --replace-location / --remove-location /
 * --replace-test` in their own terminal, or decides the issue. None of these is the coder's to take.
 */
export function planCorrectionRoutes(workflow, ownerId, currentPhaseId, clauseIds, planned = {}) {
  const [clause] = clauseIds ?? [];
  if (!clause) return { text: '', routes: [] };
  const workId = workflow.workItem.id;
  const row = planned[clause] ?? {};
  const location = row.expectedPaths?.[0] ?? '<PATH>';
  const test = row.tests?.[0] ?? '<TEST>';
  const owner = ownerId ?? 'the plan';
  const raised = ownerId ? raiseUpstreamIssueRoute(workflow, ownerId, currentPhaseId) : null;
  const decide = `an approver of ${owner} corrects the row in their own terminal`;
  const routes = [
    { command: `singularity-flow decision plan ${workId} --replace-location ${clause}=${location}:<NEW-PATH> --reason <why>`,
      label: `If ${owner} put ${clause} in the wrong place, ${decide}; no code is rewritten for it.` },
    { command: `singularity-flow decision plan ${workId} --remove-location ${clause}=${location} --reason <why>`,
      label: `If ${clause} needs no change at ${location}, ${decide}.` },
    { command: `singularity-flow decision plan ${workId} --replace-test ${clause}=${test}:<NEW-TEST> --reason <why>`,
      label: `If ${clause}'s planned test is the wrong file, ${decide}.` },
    ...(raised ? [{ command: raised.command.replace('<clause-or-section>', clauseIds.join(',')), skill: '/sf-decide',
      label: `Or record it for ${owner}'s approvers and keep working: they decide a plan correction, a return, an accepted risk or a dismissal.` }] : [])
  ];
  const text = ` If ${owner}'s plan is what is wrong, ${decide} (singularity-flow decision plan ${workId} --replace-location, --remove-location or --replace-test)`
    + `${raised ? `, or ${raised.command.replace('<clause-or-section>', clauseIds.join(','))} records it for them` : ''}.`;
  return { text, routes };
}

/** A coverage result without the clauses a decided upstream issue settles, which no longer count against it. */
export function withoutSettledClauses(coverage, settled) {
  if (!settled.length) return coverage;
  const ids = new Set(settled.map((entry) => entry.clauseId));
  const unimplemented = coverage.unimplemented.filter((id) => !ids.has(id));
  const complete = !unimplemented.length && !(coverage.unclaimedChangedPaths ?? []).length
    && !(coverage.withdrawnButClaimed ?? []).length && !(coverage.invalidEvidence ?? []).length;
  return { ...coverage, unimplemented, complete, ...(complete ? { severity: 'pass' } : {}), settledByUpstreamIssue: settled };
}

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
  const enforcement = codeCoverageEnforcement(policy);
  if (!enforcement || workflow.resolution?.plannedClaims?.mode !== 'required') return null;
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
  const evaluated = evaluateSpecCoverage({ ...records, observed: [
    ...records.observed.filter((record) => record.phase !== phase.id), { ...observed, phase: phase.id }
  ] }, changed, policy, { workflow });
  // A clause a decided upstream issue settles is never thrown back at this step's author [PHR:REQ-003].
  const coverage = withoutSettledClauses(evaluated, settledUpstreamClauses(workflow, phase.id,
    evaluated.unimplemented.filter((id) => final || allocated[id])));
  const open = coverage.unimplemented.filter((id) => final || allocated[id]);
  const claimGaps = open.map(clauseId => {
    const plan = allocated[clauseId];
    const claim = observed.claims[clauseId];
    const expected = plan && (!plan.fulfillment || ['new', 'modified'].includes(plan.fulfillment))
      ? plannedProductSourcePaths(plan) : plan?.expectedPaths ?? [];
    const missingSourcePaths = expected.filter(candidate => !isConfigurationPath(candidate)
      && !(claim?.observedPaths ?? []).includes(candidate));
    const missingConfigurationPaths = (plan?.expectedPaths ?? []).filter(candidate =>
      isConfigurationPath(candidate) && !(claim?.observedPaths ?? []).includes(candidate));
    const sourcePaths = new Set([...(delivery.sourcePaths ?? []), ...(delivery.deletedSourcePaths ?? [])]);
    return { clauseId, verdict: claim?.verdict ?? 'missing',
      missingSourcePaths: missingSourcePaths.filter(candidate => !sourcePaths.has(candidate)),
      missingSourceBindings: missingSourcePaths.filter(candidate => sourcePaths.has(candidate)),
      missingTestPaths: (plan?.tests ?? []).filter(candidate => !(claim?.testResults ?? []).includes(candidate)),
      missingConfigurationPaths };
  });
  const gapText = claimGaps.map(gap => `${gap.clauseId} (${[
    ...(gap.missingSourcePaths.length ? [`source paths: ${gap.missingSourcePaths.join(', ')}`] : []),
    ...(gap.missingSourceBindings.length ? [`source bindings: ${gap.missingSourceBindings.join(', ')}`] : []),
    ...(gap.missingTestPaths.length ? [`test paths/bindings: ${gap.missingTestPaths.join(', ')}`] : []),
    ...(gap.missingConfigurationPaths.length ? [`configuration paths: ${gap.missingConfigurationPaths.join(', ')}`] : [])
  ].join('; ') || gap.verdict})`).join('; ');
  // Recorded coverage is told, not refused: the ending refuses only what is still open then.
  if ((open.length || (final && coverage.invalidEvidence.length)) && enforcement !== 'enforce') {
    return { ...coverage, advisory: [`Planned delivery is incomplete: ${gapText || coverage.invalidEvidence.join('; ')}. This Story's ending refuses an unimplemented clause; deliver it in this step or a later one.`] };
  }
  const waiting = upstreamWaiting(workflow, upstreamDecisionFor(workflow, open));
  const corrections = waiting.details.upstreamDecision?.complete ? { text: '', routes: [] } : planCorrectionRoutes(workflow, owner, phase.id, open, allocated);
  if (open.length || (final && coverage.invalidEvidence.length)) throw new SingularityFlowError(
    `Phase '${phase.id}' has incomplete planned delivery before publication: ${gapText || coverage.invalidEvidence.join('; ')}.${waiting.text} `
    + `Inspect these exact source/test obligations while this generation is editable. Add a binding only where the approved behavior is actually implemented; an incorrect location needs a reviewed plan correction.${corrections.text} Preserve application code and approved maps. A screenshot is fulfillment evidence, not an executable test or an automatic visual pass.`,
    { code: 'SPEC_COVERAGE_INCOMPLETE', details: { workId: workflow.workItem.id, phase: phase.id,
      coverage, claimGaps, planningOwner: owner, diagnosticCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      ...waiting.details, ...(corrections.routes.length ? { planCorrections: corrections.routes } : {}) } });
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
    // As publication selects them: an untracked generated or test-runner output is never committed.
    const changed = [...new Set(changeSet.entries.filter((entry) => isApplicationChangeEntry(entry, pathContext))
      .flatMap((entry) => [entry.newPath, entry.oldPath]).filter(Boolean).map(posix))]
      .filter((candidate) => isApplicationPath(candidate, pathContext) && !excluded(candidate, policy.excludes))
      .sort();
    const unclaimed = changed.filter((candidate) => !accounted.has(candidate));
    const advisories = unclaimed.slice(0, MAXIMUM_ADVISORIES).map((candidate) => Object.freeze({
      code: 'spec.coverage.unclaimed-path', category: 'coverage', blocking: false, requiredBefore: 'approve',
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
