/**
 * The changed paths the final code approval would refuse as unclaimed, found while the generation
 * is still open. Approval accepts a changed application path only when a planned clause names it in
 * its Expected paths or planned tests, or the plan lists it under `## Supporting files`; otherwise
 * it refuses the phase, and that used to surface only after submission. Read-only and bounded, it
 * never throws: draft-check and prepublish carry its results as non-blocking advisories, and
 * approval keeps its own exact check over the submitted revision.
 */
import { applicationPathContext, isApplicationChangeEntry, isApplicationPath } from './engine-compatibility/node-source-policy.mjs';
import { accountedAmendmentPaths } from './plan-amendments.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { loadBoundActiveSpecRecords, mergePlannedClaimRecords, plannedSupportingFiles } from './specifications.mjs';
import {candidateSpecificationCoverageReplay} from './engine-compatibility/node-specification-policy.mjs';
import {SPECIFICATION_CLAIM_TIMESTAMP_REQUEST} from './kernel/specification-values.mjs';
import { normalizeSpecPolicy } from "./kernel/configuration-policy.mjs";
import { workDir } from './story-paths.mjs';
import { issueNamesClause, OPEN_UPSTREAM_ISSUE_STATUSES, upstreamIssueStates } from './upstream-routes.mjs';
import { posix, SingularityFlowError, nowIso } from './util.mjs';

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
  const replay=candidateSpecificationCoverageReplay(config,workflow,phase,delivery,{pathContext:applicationPathContext(config,workflow)});let step=replay.next();
  while(!step.done){let reply;try{const request=step.value;
    if(request===SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)reply=nowIso();
    else if(request.kind==='candidate-coverage-records')reply=await loadBoundActiveSpecRecords(root,workDir(root,config,workflow.workItem.id),workflow,request.policy,request.options);
    else throw new SingularityFlowError('Unsupported candidate coverage observation.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }catch(error){step=replay.throw(error);continue;}step=replay.next(reply);}
  if(step.value===null)return null;
  const {coverage,open,claimGaps,owner}=step.value;
  const gapText = claimGaps.map(gap => `${gap.clauseId} (${[
    ...(gap.missingSourcePaths.length ? [`source paths: ${gap.missingSourcePaths.join(', ')}`] : []),
    ...(gap.missingSourceBindings.length ? [`source bindings: ${gap.missingSourceBindings.join(', ')}`] : []),
    ...(gap.missingTestPaths.length ? [`test paths/bindings: ${gap.missingTestPaths.join(', ')}`] : []),
    ...(gap.missingConfigurationPaths.length ? [`configuration paths: ${gap.missingConfigurationPaths.join(', ')}`] : [])
  ].join('; ') || gap.verdict})`).join('; ');
  // Recorded coverage is told, not refused: the ending refuses only what is still open then.
  if (step.value.status === 'advisory') {
    return { ...coverage, advisory: [`Planned delivery is incomplete: ${gapText || coverage.invalidEvidence.join('; ')}. This Story's ending refuses an unimplemented clause; deliver it in this step or a later one.`] };
  }
  const upstreamDecision = upstreamDecisionFor(workflow, open);
  const waitingText = upstreamDecision ? ` ${upstreamDecision.issues.map((entry) => `${entry.id} (raised against ${entry.phase}) names ${entry.clauses.join(', ')}`).join('; ')}: `
    + `${upstreamDecision.complete ? 'every clause listed here waits' : 'those clauses wait only'} on that decision by ${[...new Set(upstreamDecision.issues.map((entry) => entry.phase))].join(' and ')}'s approvers, not on this step's code`
    + `${upstreamDecision.complete ? '; they decide it in the decision list (singularity-flow decisions ' + workflow.workItem.id + ').' : '; deliver the others.'}` : '';
  if (step.value.status === 'correction-required') throw new SingularityFlowError(
    `Phase '${phase.id}' has incomplete planned delivery before publication: ${gapText || coverage.invalidEvidence.join('; ')}.${waitingText} `
    + 'Inspect these exact source/test obligations while this generation is editable. Add a binding only where the approved behavior is actually implemented; an incorrect location needs a reviewed plan correction. Preserve application code and approved maps. A screenshot is fulfillment evidence, not an executable test or an automatic visual pass.',
    { code: 'SPEC_COVERAGE_INCOMPLETE', details: { workId: workflow.workItem.id, phase: phase.id,
      coverage, claimGaps, planningOwner: owner, diagnosticCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`,
      ...(upstreamDecision ? { upstreamDecision } : {}),
      // Every gap waits on a person's decision: the decision list is the way through, for every surface.
      ...(upstreamDecision?.complete ? { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id} --json`, skill: '/sf-decide',
        label: `${[...new Set(upstreamDecision.issues.map((entry) => entry.phase))].join(' and ')}'s approvers decide ${upstreamDecision.issues.map((entry) => entry.id).join(', ')} (return, plan correction, accepted risk or dismissal) in the decision list.` } } : {}) } });
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
