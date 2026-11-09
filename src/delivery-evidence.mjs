import {codeDeliveryReceiptReplay,codeDeliveryEvidencePath as safeEvidencePath,prepareCodeDeliveryReportReader} from './engine-compatibility/node-source-policy.mjs';
import {deliveryPathCohorts} from './engine-compatibility/node-source-policy.mjs';
import {affectedDeliveryPaths,testCoverageExemptPath,testCoverageDeliveryPaths,uncoveredTestDeliveryPaths} from './engine-compatibility/node-source-policy.mjs';
export {affectedDeliveryPaths,testCoverageExemptPath,testCoverageDeliveryPaths,uncoveredTestDeliveryPaths} from './engine-compatibility/node-source-policy.mjs';
import {pathInside,isDocumentationPath,classifyDeliveryChanges} from './engine-compatibility/node-source-policy.mjs';
export {classifyDeliveryChanges} from './engine-compatibility/node-source-policy.mjs';
import { createHash } from 'node:crypto';
import { runBoundedTaskPool } from './quality-command-runner.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './package-root.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { renderPlatformCommand } from './safe-command-guidance.mjs';

const CORNER_CASE_MODULE = pathToFileURL(path.join(PACKAGE_ROOT, 'src/verification/corner-case-obligations.mjs')).href;

import { phaseRequiresCodeDelivery, storyTestScope } from './code-delivery-policy.mjs';
import { nextPhaseGeneration } from './kernel/phase-policy.mjs';
import {
  configuredTestModuleOverrides, isAllowedTestAutomationPath, isExecutableTestSourcePath,
  isSupportingTestResourcePath, isTestSourceName, persistedOccurrences, prepareTestReportReader, readDurableTestObservation, replayTestReports,
  resolveAffectedModule
} from './code-delivery-tests.mjs';
import {
  buildRepositoryChangeSet, buildRepositoryTreeChangeSet, evaluateSourceBoundary
} from './repository-change-set.mjs';
import {
  autoCandidateResourceDigest, validateAutoCandidateBinding,
  validateAutoCandidateVerification
} from './auto/auto-candidate.mjs';
import { evaluateStoryProtectedPaths } from './engine-compatibility/node-source-policy.mjs';
import { committedFilesAtRevisions, exactChangedPathsBetweenObjects, exactFileAtObject, isAncestor, prefetchExactObjectFiles } from './git.mjs';
import { canonicalJson } from './foundation/record-schema.mjs';
import { normalizeSourceBoundary } from "./kernel/configuration-declarations.mjs";
import { configurationPathKind, isConfigurationPath } from './engine-compatibility/node-source-policy.mjs';
import { normalizeExternalCommand } from "./engine-compatibility/node-configuration-path.mjs";
import { readRecord } from './schema-migrations.mjs';
import {
  SOURCE_CHANGING_FULFILLMENT, loadActiveSpecRecords, mergePlannedClaimRecords, predecessorSpecClauses,
  readBoundSpecificationClaimMap, plannedProductSourcePaths
} from './specifications.mjs';
import {
  discoverDeclarations, profileForCommand, profileIsExact, testAdapterProfile
} from './verification/adapters.mjs';
import { normalizeQualifiedClauseId } from './foundation/traceability-ids.mjs';
import { scanSourceClauseTags } from './source-clause-tags.mjs';
import { codeCandidateScope, outsideEveryCandidate, unreconciledCandidatePaths } from './candidate-scope.mjs';
import { crossPhaseChange, describeCrossPhaseChange } from './evidence/cross-phase-change.mjs';
import { contractRequiresTestTag, effectiveContract, mergedVerificationContracts } from './verification/contracts.mjs';
import { scanJavaScriptDeclarations } from './verification/javascript-declarations.mjs';
import { implementationBindings } from './implementation-bindings.mjs';
import { inferRepositoryTestCommands } from './repository-test-command-inference.mjs';
import { SingularityFlowError, posix, run, secureRepositoryPath, snapshot, SUBPROCESS_MAX_BUFFER_BYTES } from './util.mjs';
import { committedChangedPaths, excludeAlwaysLocalNames, mergedBaseChanges, trackedPaths, worktreePatchMatching } from './git.mjs';
import {
  applicationChangeSetProjection, applicationPathContext, isApplicationChangeEntry, isApplicationPath,
  isGeneratedOutputPath, verifyWorkIntervalBaseline
} from './work-intervals.mjs';

export { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
export { inferRepositoryTestCommands };

function pinnedTestEvidenceSource(workflow, phase) {
  return workflow.resolution?.phases?.find((entry) => entry.id === phase?.id)?.testEvidenceFrom ?? null;
}

/** The Code step whose tests a review relies on: its pinned source, else the closest approved one. */
export function reviewCodeSource(workflow, phase) {
  if (!phase || phaseRequiresCodeDelivery(phase)) return null;
  const pinned = pinnedTestEvidenceSource(workflow, phase);
  if (pinned) return workflow.phases?.[pinned] ?? null;
  const order = workflow.phaseOrder ?? [];
  return order.slice(0, Math.max(0, order.indexOf(phase.id))).reverse().map((id) => workflow.phases?.[id])
    .find((candidate) => candidate?.status === 'approved' && phaseRequiresCodeDelivery(candidate)) ?? null;
}

/** A review whose own approval policy may send its source or test edits back to this Code step. */
export function reviewMayReturnToCode(review, code) {
  return Boolean(review && code) && !phaseRequiresCodeDelivery(review) && phaseRequiresCodeDelivery(code)
    && (review.approvalPolicy?.rejectTo ?? []).includes(code.id);
}

/**
 * The approved Code step an in-progress review may hand its source or test edits back to through
 * the guarded `reject <review> --to <code> --repair` route, or null when no such return exists.
 */
export function reviewRepairTarget(workflow, phase) {
  const code = reviewCodeSource(workflow, phase);
  return code?.status === 'approved' && workflow.status !== 'closed'
    && workflow.currentPhase === phase.id && phase.status === 'in_progress'
    && reviewMayReturnToCode(phase, code) ? code : null;
}

/**
 * The open change request a person's rejection or reopen recorded when it returned this already
 * published code step for rework, from the step itself or a later one, or null. It must be the
 * newest open return into this step, its decision must still stand, and its reset must be the one
 * that reopened this exact generation, so an older or unrelated request never qualifies.
 */
function reworkReturnRequest(workflow, phase) {
  const generation = Number(phase?.generation ?? 0);
  const evidence = phase?.deliveryEvidence;
  if (!(generation > 0) || !phase.generationCommit || evidence?.status !== 'ready' || !evidence.receiptSha256) return null;
  const request = [...(workflow.changeRequests ?? [])].reverse().find((candidate) =>
    candidate.status === 'open' && candidate.targetPhase === phase.id);
  const source = workflow.phases?.[request?.sourcePhase];
  const order = workflow.phaseOrder ?? [];
  // A decision's loop has no person's return to cite, and a confirmed repair keeps its own binding.
  if (!request || request.decision || request.testingRepair || !source || !order.includes(source.id)
      || order.indexOf(source.id) < order.indexOf(phase.id)) return null;
  const decided = (source.approvals ?? []).some((decision) => ['rejected', 'reopened'].includes(decision.decision)
    && !decision.invalidatedAt && decision.target === phase.id && decision.changeRequestId === request.id);
  const reset = phase.reworkRevalidation;
  return decided && Number(reset?.generation) === generation && reset.invalidatedAt === request.requestedAt
    ? request : null;
}

/**
 * The return to a step before this one that reset this published code step: an upstream issue's
 * return, or a rejection sent further back. What it corrects (the plan, the scope) may need no code
 * change, yet the next generation was refused as unchanged, so the Story could go on only with a
 * fake edit (2026-10-28). That generation carries the previous one's exact source and tests and runs
 * them again, as an intent revalidation does; whatever the corrected plan still owes is judged as for
 * any generation. Only the reset that reopened this exact generation qualifies.
 */
function earlierReturnRequest(workflow, phase) {
  const generation = Number(phase?.generation ?? 0);
  const evidence = phase?.deliveryEvidence;
  const reset = phase?.reworkRevalidation;
  if (!(generation > 0) || !phase.generationCommit || evidence?.status !== 'ready' || !evidence.receiptSha256
      || Number(reset?.generation) !== generation) return null;
  const order = workflow.phaseOrder ?? [];
  const request = [...(workflow.changeRequests ?? [])].reverse().find((candidate) => candidate.requestedAt === reset.invalidatedAt) ?? null;
  if (!request || request.decision || request.testingRepair || order.indexOf(request.targetPhase) < 0
      || order.indexOf(request.targetPhase) >= order.indexOf(phase.id)) return null;
  return request;
}

/**
 * The route a refused test-only or unchanged code generation takes, or null. A first generation
 * must implement; a later one carries its previous generation's unchanged source only when a
 * person's return reopened it; one left unchanged after a return is withdrawn by that return's
 * reviewers, which restores the generation it returned. Never a fake product-source edit.
 */
function testOnlyDeliveryRoute(workflow, phase, { unchanged, testOnly }) {
  const workId = workflow.workItem.id;
  const generation = Number(phase.generation ?? 0);
  const request = [...(workflow.changeRequests ?? [])].reverse().find((candidate) =>
    candidate.status === 'open' && candidate.targetPhase === phase.id) ?? null;
  // Withdrawal fits a return made over clean work. A confirmed repair's checkpoint holds the
  // review's own edits, which withdrawing would bring back; left unchanged, it publishes instead.
  if (unchanged && generation > 0 && request?.forwardCheckpoint && !request.decision && !request.testingRepair) {
    const command = `singularity-flow story rework roll-forward --work-id ${workId} --change-request ${request.id} --json`;
    return Object.freeze({
      kind: 'withdraw-return', changeRequestId: request.id, command, skill: '/sf-reject',
      guidance: `Nothing changed since generation ${generation}, which ${request.id} returned to ${phase.id}. Make the change it asks for, then publish again. `
        + `If no change is needed, a reviewer of ${request.sourcePhase} withdraws the return instead; that restores generation ${generation} and ${request.sourcePhase} as they stood before ${request.id}, and keeps the history. `
        + `Review its preview, then use the --confirm form it prints.\n${formatCommandRouteLines({ command, copilotCommand: '/sf-reject' }).join('\n')}`
    });
  }
  if (!testOnly) return null;
  if (generation === 0) {
    const owner = workflow.resolution?.plannedClaims?.owners?.[phase.id] ?? '<EARLIER>';
    return Object.freeze({
      kind: 'first-generation', command: null, skill: null,
      guidance: `This is ${phase.id}'s first generation, so a test-only change implements nothing: deliver the approved behavior in its planned product source, with each clause comment in that change, and publish again. `
        + 'Only a later generation that a reviewer returned asking for tests carries earlier source unchanged. '
        + `If a clause truly needs only tests, the plan that owes source for it is what is wrong: raise it against ${owner}, whose approvers correct the row's Fulfillment (test-only, or existing where the behavior already lives). `
        + `\n${formatCommandRouteLines({ copilotCommand: '/sf-decide', command: `singularity-flow upstream-issue raise --work-id ${workId} --phase ${owner} --about <CLAUSE-ID> --problem "<TEXT>"` }).join('\n')}`
    });
  }
  const why = !request ? `no return into ${phase.id} is open`
    : request.decision ? `${request.id} is decision '${request.decision.id}' going round again, not a person's return`
      : `${request.id} did not reopen generation ${generation}`;
  return Object.freeze({
    kind: 'return-required', changeRequestId: request?.id ?? null, command: null, skill: null,
    guidance: `A test-only change carries generation ${generation}'s unchanged source only in a generation that a reviewer's rejection (reject <step> --to ${phase.id}) or a confirmed review repair returned to ${phase.id}; ${why}. `
      + 'Change the planned product source the correction needs, with its clause comments, and publish again.'
  });
}

/**
 * The source boundary a review may repair inside its own generations. Only a review that writes
 * source, confines itself to an explicit boundary and produces its own test evidence qualifies.
 * One that consumes another step's tests (testEvidenceFrom) or may write anywhere still needs a
 * Code generation to retest every source or test change.
 */
export function reviewOwnRepairBoundary(workflow, phase) {
  if (!phase || phaseRequiresCodeDelivery(phase)
      || (phase.writeScope ?? 'artifact-only') !== 'source-and-artifact'
      || pinnedTestEvidenceSource(workflow, phase)) return null;
  const boundary = normalizeSourceBoundary(phase.sourceBoundary, phase.id);
  return boundary === 'unrestricted' ? null : boundary;
}

function currentSubmission(workflow, phase) {
  return [...(workflow.lineage?.submissions ?? [])].reverse().find((candidate) =>
    candidate.phase === phase.id && Number(candidate.generation) === Number(phase.generation)) ?? null;
}

// Both endpoints matter: moving tested source into README.md is still a source deletion.
function unpermittedReviewChange(entry, { pathContext, boundary = null, phaseId }) {
  return [entry.oldPath, entry.newPath].filter(Boolean).some((candidate) => {
    const endpoint = { ...entry, oldPath: candidate, newPath: candidate };
    // Untracked generated output is already excluded by the application boundary. Tracked build,
    // vendor and coverage files can be executable inputs, so their names cannot waive fresh tests.
    const role = classifyDeliveryChanges({ entries: [endpoint] }, { pathContext }).entries[0]?.role;
    if (!role || role === 'documentation') return false;
    return !(boundary && evaluateSourceBoundary({ entries: [endpoint] }, boundary, {
      phaseId, allowedPath: isAllowedTestAutomationPath
    }).valid);
  });
}

async function unpermittedReviewPaths(root, baseCommit, subject, permission) {
  const changes = await buildRepositoryChangeSet(root, { baseCommit, subject });
  return [...new Set(changes.entries.filter((entry) => unpermittedReviewChange(entry, permission))
    .flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))].sort();
}

/**
 * Bytes a later governed publication introduced are not out-of-band edits. Advance the comparison
 * base from the source evidence through the current submission of every other step allowed to
 * change application paths, oldest first. Code evidence attests its whole tested tree; a review
 * that repairs inside its own boundary counts only when everything since the previous base is
 * documentation or inside that boundary. A submission that cannot be verified explains nothing.
 */
async function governedReviewBaseline(root, config, workflow, { phase, source, evidenceCommit, pathContext }) {
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const checkpoints = [];
  for (const candidate of (workflow.phaseOrder ?? []).map((id) => workflow.phases?.[id])) {
    if (!candidate || candidate.id === phase.id || candidate.id === source.id) continue;
    try {
      const code = phaseRequiresCodeDelivery(candidate);
      const boundary = code ? null : reviewOwnRepairBoundary(workflow, candidate);
      const entry = code || boundary ? currentSubmission(workflow, candidate) : null;
      if (!entry) continue;
      const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
      if (packet.workId === workflow.workItem.id && packet.phase === candidate.id
          && Number(packet.generation) === Number(candidate.generation) && packet.evidenceCommit
          && packet.evidenceCommit !== evidenceCommit && isAncestor(root, evidenceCommit, packet.evidenceCommit)) {
        checkpoints.push({ phaseId: candidate.id, boundary, commit: packet.evidenceCommit });
      }
    } catch { /* the refusal this checkpoint might have explained stands */ }
  }
  checkpoints.sort((left, right) => (left.commit === right.commit ? 0
    : isAncestor(root, left.commit, right.commit) ? -1 : 1));
  let base = evidenceCommit;
  for (const checkpoint of checkpoints) {
    if (checkpoint.commit === base || !isAncestor(root, base, checkpoint.commit)) continue;
    if (checkpoint.boundary) {
      let paths;
      try { paths = exactChangedPathsBetweenObjects(root, base, checkpoint.commit); } catch { continue; }
      const permission = { pathContext, boundary: checkpoint.boundary, phaseId: checkpoint.phaseId };
      if (paths.some((candidate) => unpermittedReviewChange({ oldPath: candidate, newPath: candidate }, permission))) continue;
    }
    base = checkpoint.commit;
  }
  return base;
}

/**
 * Review may repair documents, and a review whose own policy confines it to a source boundary
 * may repair inside it; only a code generation can replace any other tested source or tests.
 * `verifiedCodeInput` is the result of assertPassedCodeDeliveryInput from the same operation.
 */
/**
 * The Story base branch's own changes among `paths`, merged onto the Story branch (git
 * mergedBaseChanges). Only for a Story that runs on its pinned workflow snapshot: a legacy Story
 * reads the live configuration, so a merged change would change its rules, and stays refused.
 */
export function storyMergedBaseChanges(root, config, workflow, paths) {
  const base = workflow.workItem?.baseBranch;
  if (!base || !workflow.workflowSnapshot) return null;
  const remote = config.git?.remote ?? 'origin';
  return mergedBaseChanges(root, { startCommit: workflow.workItem.baseCommit ?? null,
    baseRefs: [`refs/remotes/${remote}/${base}`, `refs/heads/${base}`], paths });
}

export async function assertReviewCodeEvidenceFresh(root, config, workflow, phase, { verifiedCodeInput = null } = {}) {
  if (phaseRequiresCodeDelivery(phase)) return null;
  const source = reviewCodeSource(workflow, phase);
  if (!source) return null;
  const entry = currentSubmission(workflow, source);
  const repairCommand = workflow.status === 'closed'
    ? `singularity-flow reopen ${workflow.workItem.id} --to ${source.id} --reason <REASON>`
    : reviewRepairTarget(workflow, phase)?.id === source.id
      ? `singularity-flow reject ${phase.id} --to ${source.id} --repair --reason <REASON>`
      : phase.status === 'awaiting_approval' && reviewMayReturnToCode(phase, source)
        ? `singularity-flow reject ${phase.id} --to ${source.id} --reason <REASON>` : null;
  const refuse = (message, changedPaths = [], evidenceAvailable = true) => new SingularityFlowError(
    `Phase '${phase.id}' requires current Code evidence from '${source.id}': ${message} `
      + `Return the changes to '${source.id}', publish and validate a fresh code generation, then resume '${phase.id}'.`
      + (evidenceAvailable && repairCommand ? ` Preview the exact repair with: ${repairCommand}.`
        : evidenceAvailable ? ' The current phase policy has no available direct return; inspect singularity-flow nextsteps --json and request an authorized workflow return.'
          : ' Restore the original Code submission evidence before requesting a confirmed return; run singularity-flow doctor --json to inspect missing evidence.'),
    { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', details: { phase: phase.id, sourcePhase: source.id, changedPaths,
      repairCommand: evidenceAvailable ? repairCommand : null } }
  );
  if (!entry) throw refuse('the approved code generation has no immutable submission.', [], false);
  // The pinned input check of this same operation already replayed this exact submission, proved
  // the application tree is byte-for-byte the one its tests ran on, and applied its risk gate.
  if (verifiedCodeInput?.applicationTreeTested === true && verifiedCodeInput.sourcePhase === source.id
      && verifiedCodeInput.packetSha256 === entry.packetSha256) {
    return { sourcePhase: source.id, evidenceCommit: verifiedCodeInput.evidenceCommit };
  }
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
  if (packet.workId !== workflow.workItem.id || packet.phase !== source.id
      || Number(packet.generation) !== Number(source.generation) || !packet.evidenceCommit) {
    throw refuse('the submitted code identity does not match its approved generation.', [], false);
  }
  const pathContext = applicationPathContext(config, workflow);
  const subject = { workId: workflow.workItem.id, phase: phase.id, generation: phase.generation };
  const permission = { pathContext, boundary: reviewOwnRepairBoundary(workflow, phase), phaseId: phase.id };
  let changedPaths = await unpermittedReviewPaths(root, packet.evidenceCommit, subject, permission);
  let comparisonBase = packet.evidenceCommit;
  // A review pinned to one step's tests (testEvidenceFrom) consumes exactly that tested tree.
  if (changedPaths.length && !pinnedTestEvidenceSource(workflow, phase)) {
    const base = await governedReviewBaseline(root, config, workflow, {
      phase, source, evidenceCommit: packet.evidenceCommit, pathContext
    });
    if (base !== packet.evidenceCommit) {
      changedPaths = await unpermittedReviewPaths(root, base, subject, permission);
      comparisonBase = base;
    }
  }
  // An uncommitted file no plan names was never part of the tested candidate, so it cannot make it
  // stale [D9]; once committed it is part of what ships, and it does.
  const outsidePlan = changedPaths.length
    ? await outsideEveryCandidate(path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id), workflow) : null;
  if (outsidePlan) {
    const committed = new Set(committedChangedPaths(root, comparisonBase));
    changedPaths = changedPaths.filter((candidate) => committed.has(candidate) || !outsidePlan(candidate));
  }
  if (changedPaths.length) {
    // One evaluator maps the change to its obligations and the returns the workflow permits [E2G-022].
    const change = await crossPhaseChange(root, config, workflow, phase, changedPaths);
    const described = describeCrossPhaseChange(change, { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', gate: 'consumption', workflow, phase });
    // Changes main made, merged in after the code was approved, read as the Story's own edits
    // (2026-10-28). The approved tests still never ran with them, so the repair stays; the cause is named.
    const merged = storyMergedBaseChanges(root, config, workflow, changedPaths);
    const fromBase = merged?.paths.length
      ? ` ${merged.paths.length === changedPaths.length ? 'All of them' : `${merged.paths.join(', ')}`} came from ${workflow.workItem.baseBranch} through a merge, not from this Story; `
        + `the approved tests never ran with them, so ${source.id} runs its tests again on the merged code, or the merge waits until ${workflow.workItem.id} ends.`
      : '';
    throw new SingularityFlowError(
      `Phase '${phase.id}' requires current Code evidence: source or tests changed after their approved execution: ${changedPaths.join(', ')}.${fromBase} ${described.text}`,
      { code: 'PRIOR_CODE_TEST_EVIDENCE_STALE', details: { phase: phase.id, sourcePhase: source.id, changedPaths,
        ...(merged?.paths.length ? { mergedFromBase: { branch: workflow.workItem.baseBranch, commit: merged.commit, paths: merged.paths } } : {}),
        repairCommand: change.returns.find((entry) => entry.permitted)?.command ?? null, crossPhase: change, gate: described.gate } }
    );
  }
  const riskReference = source.deliveryEvidence?.testRecovery;
  if (riskReference) {
    const { assertStoryTestRiskGate } = await import('./test-recovery-runtime.mjs');
    await assertStoryTestRiskGate(root, config, workflow, { phaseId: source.id,
      generation: source.generation, operation: 'downstream',
      observationSha256: riskReference.observationSha256, evidenceCommit: packet.evidenceCommit });
  }
  return { sourcePhase: source.id, evidenceCommit: packet.evidenceCommit };
}

// Keep source-comment preflight below the exact local-object replay reader's 16 MiB ceiling.
// Otherwise a generation could publish successfully and only fail at submission or approval.
const MAX_BOUND_SOURCE_BYTES = 16 * 1024 * 1024;

function legacySpecificationText(text) {
  return text
    .replace(/<!-- singularity-flow:metadata[\s\S]*?-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(```|~~~)[^\r\n]*[\r\n][\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/`[^`\r\n]+`/g, '');
}

export async function acceptanceIds(root, config, workflow, phase) {
  if (!config.governance?.requireAcceptanceCriteriaTags) return [];
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const indexed = predecessorSpecClauses(records, workflow, phase.id)
    .filter((clause) => clause.type === 'AC' || /:AC-\d+$/.test(clause.id ?? ''))
    .map((clause) => clause.id);
  // A Story with a specification index owes only criteria it defines, possibly none. A criterion
  // named only in prose is not one: publication refuses its tag (unknownCriterionTags).
  if (specificationCriteria(records, workflow, config)) {
    // A criterion the plan allocates to other code steps is owed by those steps only; with no
    // allocation every code step owes it [E2G-009, §12 #5].
    const planned = mergePlannedClaimRecords(records.planned ?? []);
    const owedHere = (id) => {
      const steps = (planned[id] ?? planned[String(id).toUpperCase()])?.steps ?? [];
      return !steps.length || steps.includes(phase.id);
    };
    // Only a criterion a test must verify needs an @ac tag [E2G-013]: one verified by inspection or
    // visual evidence, or whose tests the plan reviewed as not applicable, needs none.
    const contracts = mergedVerificationContracts(records.planned ?? []);
    const tested = (id) => contractRequiresTestTag(effectiveContract(String(id).toUpperCase(), contracts,
      planned[id] ?? planned[String(id).toUpperCase()] ?? null));
    return [...new Set(indexed.filter(owedHere).filter(tested))].sort();
  }
  // Compatibility for workflows created before specification indexes existed. New records always
  // preserve the namespace; a legacy bare suffix is normalized only when a configured namespace
  // makes the identity unambiguous.
  const namespace = (workflow.resolution?.spec ?? config.spec)?.namespace ?? null;
  const position = workflow.phaseOrder.indexOf(phase.id);
  const ids = new Set();
  for (const phaseId of workflow.phaseOrder.slice(0, Math.max(0, position))) {
    const prior = workflow.phases[phaseId];
    if (!prior?.requiredArtifact?.path) continue;
    const relative = posix(path.join(
      config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
      prior.requiredArtifact.path
    ));
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Acceptance specification source', type: 'file'
    });
    if (!secured.exists) continue;
    const text = legacySpecificationText(await readFile(secured.absolute, 'utf8'));
    for (const match of text.matchAll(/\b(?:[A-Z0-9][A-Z0-9._-]{0,63}:)?AC-\d+\b/gi)) {
      const value = match[0].toUpperCase();
      ids.add(value.includes(':') ? value : namespace ? `${namespace}:${value}` : value);
    }
  }
  return [...ids].sort();
}

/**
 * The criterion tags in delivered test files [E2G-015]. One vocabulary: a namespace-qualified
 * `@ac:<NS>:AC-NNN` marker in a comment. Bare suffixes, strings and the retired `@sflow-ac`
 * spelling bind nothing. This is the file-level association; which test a tag sits on is read by
 * the module's adapter (discoverAcceptanceWitnesses).
 */
export async function taggedAcceptanceIds(root, testPaths) {
  const sources = new Map();
  const locations = [];
  for (const relative of testPaths) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Acceptance test source', type: 'file'
    });
    if (!secured.exists) continue;
    const text = await readFile(secured.absolute, 'utf8');
    for (const item of scanSourceClauseTags(text, { sourcePath: relative }).filter((entry) => entry.tag === 'ac')) {
      if (!sources.has(item.clauseId)) sources.set(item.clauseId, new Set());
      sources.get(item.clauseId).add(relative);
      locations.push({ clauseId: item.clauseId, testSource: relative, line: item.line });
    }
  }
  const bindings = [...sources.entries()].flatMap(([clauseId, files]) =>
    [...files].map((testSource) => ({ clauseId, testSource, bindingAssurance: 'namespace-qualified' })));
  return {
    ids: [...sources.keys()].sort(), inferred: [], ambiguous: [],
    bindings: bindings.sort((left, right) => left.clauseId.localeCompare(right.clauseId) || left.testSource.localeCompare(right.testSource)),
    // Each tag's own line, so a refusal can say exactly what to correct. Never part of the receipt.
    locations: locations.sort((left, right) => left.testSource.localeCompare(right.testSource) || left.line - right.line)
  };
}

/** taggedAcceptanceIds' result without the tag lines in `excluded`, which bind nothing here. */
function withoutTags(tags, excluded) {
  const drop = new Set(excluded);
  const locations = tags.locations.filter((location) => !drop.has(location));
  const bindings = new Map(locations.map((location) => [JSON.stringify([location.clauseId, location.testSource]),
    { clauseId: location.clauseId, testSource: location.testSource, bindingAssurance: 'namespace-qualified' }]));
  return {
    ...tags, ids: [...new Set(locations.map((location) => location.clauseId))].sort(), locations,
    bindings: [...bindings.values()].sort((left, right) => left.clauseId.localeCompare(right.clauseId) || left.testSource.localeCompare(right.testSource))
  };
}

/**
 * The criteria a test tag can name [E2G-015]: the clauses of the Story's active specification
 * indexes, the same set submission binds each witness to (story-lineage witnessReviewSnapshot).
 * `namespaces` are the Story's own: its Work ID, the configured specification namespace and every
 * namespace its specification uses. Every one but the Work ID is in `sharedNamespaces`: a configured
 * namespace is the same for every Story of its work type, and two specifications may choose the
 * same one, so a file can already carry another Story's tag there. Null for a Story without a
 * specification index: one created before indexes existed, one whose specification mode is off,
 * or a route that omits scope.
 */
export function specificationCriteria(records, workflow, config = {}) {
  if (!(records?.indexes ?? []).length) return null;
  const clauses = records.indexes.flatMap((index) => index.clauses ?? []);
  const story = String(workflow?.workItem?.id ?? '').toUpperCase();
  const namespaces = new Set([story, (workflow?.resolution?.spec ?? config.spec)?.namespace,
    ...clauses.map((clause) => namespaceOf(clause?.id))]
    .filter(Boolean).map((value) => String(value).toUpperCase()));
  return {
    held: new Set(clauses.filter((clause) => clause?.bodySha256).map((clause) => String(clause.id).toUpperCase())),
    namespaces,
    sharedNamespaces: new Set([...namespaces].filter((namespace) => namespace !== story))
  };
}

/** The namespace of a qualified clause or criterion ID: everything before its colon. */
function namespaceOf(clauseId) {
  return String(clauseId ?? '').split(':')[0];
}

/**
 * Whether a tag naming something the specification lacks is the Story's to correct [E2G-011,
 * E2G-015]: in its Work ID wherever it sits, in a namespace other Stories share only where the
 * generation added it, and in any other namespace never. `carried` returns the IDs the generation's
 * files already named at its baseline (carriedTags); it is asked only about a shared namespace.
 */
function storyOwnsTag(criteria, clauseId, carried) {
  const namespace = namespaceOf(clauseId);
  if (!criteria?.namespaces.has(namespace)) return false;
  return !criteria.sharedNamespaces.has(namespace) || !carried().has(clauseId);
}

/**
 * The tags of one kind (`clause` or `ac`) that the generation's files already carried at its
 * baseline [E2G-011, E2G-015]: every tag in a file it left unchanged, and every tag in the baseline
 * version of each file it changed, renamed, copied or deleted, so a tag that moves with its code is
 * carried too. `occurrences` are the tags read now, each with its `path`; `reads` picks the changed
 * paths worth reading. Without a change set, no tag is known to be carried.
 */
function carriedTags(root, changeSet, occurrences, kind, reads) {
  if (!changeSet?.base?.commit) return new Set();
  const entries = changeSet.entries ?? [];
  const changed = new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean));
  const carried = new Set(occurrences.filter((tag) => !changed.has(tag.path)).map((tag) => tag.clauseId));
  const earlier = committedFilesAtRevisions(root, entries
    .filter((entry) => entry.oldPath && /^100/u.test(entry.oldMode ?? '') && reads(entry.oldPath))
    .map((entry) => ({ key: entry.oldPath, ref: changeSet.base.commit, path: entry.oldPath })), {
    maximumObjectBytes: MAX_BOUND_SOURCE_BYTES, maximumBytes: 4 * MAX_BOUND_SOURCE_BYTES
  });
  for (const [relative, bytes] of earlier) {
    for (const tag of scanSourceClauseTags(bytes.toString('utf8'), { sourcePath: relative })) {
      if (tag.tag === kind) carried.add(tag.clauseId);
    }
  }
  return carried;
}

/** A path named by a `---` or `+++` patch header, without its side prefix; null for /dev/null. */
function patchHeaderPath(value, prefix) {
  let text = value.replace(/\t$/u, '');
  if (text.startsWith('"')) {
    text = text.slice(1, -1).replace(/\\([0-7]{3}|.)/gu, (_, escape) => (escape.length === 3
      ? String.fromCharCode(Number.parseInt(escape, 8)) : ({ n: '\n', t: '\t' })[escape] ?? escape));
  }
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

/**
 * The tag lines of one kind (`clause` or `ac`) this Story added, as tagKey(path, line), or null for a
 * Story with no work interval [E2G-011, E2G-015]. They are measured from the source base of the
 * Story's first work interval, which a rework or a later code step still shares; a generation's own
 * baseline is its previous commit. A line counts where the Story's change since that base adds it
 * (every line of an untracked file), unless the change removes at least as many copies of it as it
 * adds: a tag that moved with its code stays where it came from. A line that a merge brought into
 * the Story branch counts as added. `occurrences` are the tags in question, each with its `path` and
 * `line`; `reads` picks the changed paths whose lines count.
 */
async function storyAddedTagLines(root, workflow, occurrences, kind, reads) {
  const base = workflow.workIntervals?.history?.[0]?.sourceBaseCommit ?? workflow.workIntervals?.current?.sourceBaseCommit;
  if (!base) return null;
  const normalize = (line) => line.trim().replace(/\s+/gu, ' ');
  const added = new Map();
  const net = new Map();
  const count = (relative, text, delta) => {
    let counted = false;
    try { counted = Boolean(relative) && reads(relative); } catch { /* a path no rule can govern counts for nothing */ }
    if (counted) net.set(text, (net.get(text) ?? 0) + delta);
  };
  const add = (relative, line, text) => {
    if (!added.has(relative)) added.set(relative, new Map());
    added.get(relative).set(line, text);
    count(relative, text, 1);
  };
  // Only files whose change adds or removes such a line; every other tag is where the base had it.
  const patch = worktreePatchMatching(root, base, kind === 'clause' ? '@[Cc][Ll][Aa][Uu][Ss][Ee]' : '@[Aa][Cc]');
  let oldPath = null;
  let newPath = null;
  let hunk = null;
  for (const line of patch.split('\n')) {
    if (hunk?.removed > 0 && line.startsWith('-')) {
      hunk.removed -= 1;
      count(oldPath, normalize(line.slice(1)), -1);
    } else if (hunk?.added > 0 && line.startsWith('+')) {
      hunk.added -= 1;
      if (newPath) add(newPath, hunk.line, normalize(line.slice(1)));
      hunk.line += 1;
    } else if (line.startsWith('diff --git ')) {
      [oldPath, newPath, hunk] = [null, null, null];
    } else if (!hunk && line.startsWith('--- ')) {
      oldPath = patchHeaderPath(line.slice(4), 'a/');
    } else if (!hunk && line.startsWith('+++ ')) {
      newPath = patchHeaderPath(line.slice(4), 'b/');
    } else {
      const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (header) hunk = { removed: Number(header[1] ?? 1), added: Number(header[3] ?? 1), line: Number(header[2]) };
    }
  }
  const unseen = [...new Set(occurrences.map((tag) => tag.path))].filter((relative) => !added.has(relative));
  if (unseen.length) {
    const tracked = new Set(trackedPaths(root, unseen));
    for (const relative of unseen.filter((candidate) => !tracked.has(candidate))) {
      const text = await readFile(path.join(root, ...relative.split('/')), 'utf8');
      text.split(/\r?\n/u).forEach((line, index) => add(relative, index + 1, normalize(line)));
    }
  }
  return new Set(occurrences.filter((tag) => (net.get(added.get(tag.path)?.get(tag.line)) ?? 0) > 0)
    .map((tag) => tagKey(tag.path, tag.line)));
}

function tagKey(relative, line) {
  return JSON.stringify([relative, line]);
}

/**
 * Test tags naming a criterion the specification does not hold, each with the file and line to
 * correct [E2G-015]. Submission refuses such a tag once it sits on an exactly identified test
 * (WEL_WITNESS_MAPPING_STALE), so publication refuses it first, in any namespace, and in a Story
 * without a specification index too: that Story holds no criterion for a test to witness. With an
 * index, a tag in the Story's Work ID is refused wherever it sits, so a mistyped criterion cannot
 * hide in a module whose runner only counts tests; in a namespace other Stories share, so is one
 * the generation adds. Another Story's tag that sits on no exact test binds nothing here and stays,
 * as do a legacy Story's tags its runner only counts. `carried` returns the criteria the tagged
 * files already named at the generation's baseline (carriedTags), given every tag read now; it is
 * asked only about a shared namespace, and by default nothing is carried. `owed` are the criteria
 * the step must tag; without an index they come from its earlier artifacts' text (acceptanceIds),
 * and their message says that removing the tag cannot help.
 */
export function unknownCriterionTags(criteria, {
  locations = [], witnesses = [], unattachedTags = [], owed = [], carried = () => new Set()
} = {}) {
  const key = (testSource, clauseId) => JSON.stringify([testSource, String(clauseId ?? '').toUpperCase()]);
  // Exactly the witnesses submission reviews: an identified test with no gaps.
  const exact = new Set(witnesses.filter((witness) => witness.identity && !(witness.gaps ?? []).length)
    .map((witness) => key(witness.testSource, witness.clauseId)));
  const tagged = new Set(locations.map((location) => key(location.testSource, location.clauseId)));
  const occurrences = [
    ...locations,
    ...unattachedTags.flatMap((tag) => (tag.clauseIds ?? []).map((clauseId) => ({ clauseId, testSource: tag.testSource, line: tag.line }))),
    // A tag only the module's adapter reads still becomes a witness; name its test's line.
    ...witnesses.filter((witness) => !tagged.has(key(witness.testSource, witness.clauseId)))
      .map((witness) => ({ clauseId: witness.clauseId, testSource: witness.testSource, line: witness.line }))
  ];
  let carriedIds = null;
  const carriedNow = () => (carriedIds ??= carried(occurrences.map((occurrence) => ({
    clauseId: String(occurrence.clauseId ?? '').toUpperCase(), path: occurrence.testSource
  }))));
  const findings = new Map();
  for (const { clauseId: rawClauseId, testSource, line } of occurrences) {
    const clauseId = String(rawClauseId ?? '').toUpperCase();
    if (!clauseId || criteria?.held.has(clauseId)) continue;
    if (!exact.has(key(testSource, clauseId)) && !storyOwnsTag(criteria, clauseId, carriedNow)) continue;
    const where = `${testSource}${line ? `:${line}` : ''}`;
    findings.set(JSON.stringify([testSource, line ?? null, clauseId]), {
      code: 'EVIDENCE_CRITERION_UNKNOWN', clauseId, path: testSource, line: line ?? null,
      message: criteria
        ? `@ac:${clauseId} at ${where} names a criterion the active specification does not hold.`
        : owed.includes(clauseId)
          ? `@ac:${clauseId} at ${where} names a criterion this step owes, but this Story has no specification index, so submission cannot review the test that witnesses it.`
          : `@ac:${clauseId} at ${where} names a criterion, but this Story has no specification index, so no test can witness one.`
    });
  }
  return [...findings.values()].sort((left, right) => left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0) || left.clauseId.localeCompare(right.clauseId));
}

function witnessIdentity(declaration) {
  return declaration.schema === 'junit5-method-v2' || declaration.framework === 'pytest'
    ? { className: declaration.className, methodName: declaration.methodName, signature: declaration.signature }
    : { framework: declaration.framework, suitePath: declaration.suitePath, name: declaration.name };
}

/**
 * Which exact test each criterion tag sits on [E2G-015]. Every tagged test file is read by the
 * adapter of the command that runs its module: an exact profile (Jest, Vitest, JUnit 5) returns
 * declarations, each with its own gaps; a profile that only counts tests leaves the file-level
 * association, capped at module-observed. A required criterion whose tags all sit in exact modules
 * but on no test declaration is a publication error: that tag can never verify anything.
 * `othersTag({ testSource, clauseId, line })` is true where the tag a test or comment at that line
 * carries is an earlier Story's, which witnesses nothing here.
 */
export async function discoverAcceptanceWitnesses(root, phase, {
  testPaths, sourcePaths = [], requiredAcIds = [], bindings = [], othersTag = () => false,
  executionMode = 'changed-and-affected'
} = {}) {
  const commands = [];
  for (const [index, command] of (await resolveDeliveryQualityCommands(root, {
    ...phase, deliveryEvidence: { ...(phase.deliveryEvidence ?? {}), sourcePaths, testPaths }
  }, { executionMode }).catch(() => [])).entries()) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || command.kind !== 'test') continue;
    try { commands.push({ ...normalizeExternalCommand(command, index), provenance: testCommandProvenance(phase, command) }); }
    catch { /* the test preflight reports it */ }
  }
  const taggedFiles = [...new Set(bindings.map((binding) => binding.testSource))].sort();
  const groups = new Map();
  const fileProfile = new Map();
  const { commandForTestFile } = await import('./test-module-markers.mjs');
  for (const file of taggedFiles) {
    const command = await commandForTestFile(root, commands, file);
    const profile = command ? profileForCommand(command) : 'module-counts-v1';
    fileProfile.set(file, { profile, commandId: command?.id ?? null, resultAdapter: command?.result?.adapter ?? null });
    const key = `${profile}\u0000${command?.id ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const witnesses = [];
  const unattachedTags = [];
  for (const [key, files] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [profile, commandId] = key.split('\u0000');
    if (!profileIsExact(profile)) {
      for (const binding of bindings.filter((entry) => files.includes(entry.testSource))) {
        witnesses.push({
          clauseId: binding.clauseId, testSource: binding.testSource, profile, commandId: commandId || null,
          resultAdapter: fileProfile.get(binding.testSource).resultAdapter, identity: null, logicalTestId: null,
          declarationSha256: null, supportSha256: null, line: null, parameters: null, skipped: false,
          exact: false, gaps: ['ADAPTER_COUNTS_ONLY']
        });
      }
      continue;
    }
    const discovered = await discoverDeclarations(root, profile, files);
    for (const declaration of discovered.declarations) {
      for (const clauseId of declaration.clauseIds) {
        if (othersTag({ testSource: declaration.sourcePath, clauseId, line: declaration.line })) continue;
        witnesses.push({
          clauseId, testSource: declaration.sourcePath, profile, commandId: commandId || null,
          resultAdapter: testAdapterProfile(profile).resultAdapter,
          identity: witnessIdentity(declaration), logicalTestId: declaration.logicalTestId,
          declarationSha256: declaration.declarationSha256, supportSha256: declaration.supportSha256 ?? null,
          ...(declaration.assertions ? { assertions: declaration.assertions } : {}),
          line: declaration.line, parameters: declaration.parameters ?? null, skipped: declaration.skipped === true,
          exact: declaration.gaps.length === 0, gaps: declaration.gaps.map((entry) => entry.code)
        });
      }
    }
    for (const tag of discovered.unattachedTags) {
      const clauseIds = tag.clauseIds.filter((clauseId) => !othersTag({ testSource: tag.sourcePath, clauseId, line: tag.line }));
      if (clauseIds.length) unattachedTags.push({ testSource: tag.sourcePath, line: tag.line, clauseIds, code: tag.code, message: tag.message });
    }
    for (const [file, gaps] of Object.entries(discovered.fileGaps)) {
      if (!discovered.unattachedTags.some((tag) => tag.sourcePath === file)) {
        unattachedTags.push({ testSource: file, line: null, clauseIds: bindings.filter((entry) => entry.testSource === file).map((entry) => entry.clauseId), code: gaps[0].code, message: gaps[0].message });
      }
    }
  }
  const errors = [];
  const errorFindings = [];
  for (const clauseId of requiredAcIds) {
    const sources = bindings.filter((binding) => binding.clauseId === clauseId).map((binding) => binding.testSource);
    if (!sources.length || !sources.every((file) => profileIsExact(fileProfile.get(file)?.profile ?? 'module-counts-v1'))) continue;
    if (witnesses.some((witness) => witness.clauseId === clauseId && witness.identity)) continue;
    const where = unattachedTags.filter((tag) => tag.clauseIds.includes(clauseId))
      .map((tag) => `${tag.testSource}${tag.line ? `:${tag.line}` : ''} (${tag.message})`);
    errors.push(`@ac:${clauseId} is not on a test: ${where.join('; ') || sources.join(', ')}. Put the tag in a comment on the line directly above the test that verifies ${clauseId}.`);
    errorFindings.push({ code: 'code.delivery.acceptance-tag-unattached', value: clauseId });
  }
  return {
    witnesses: witnesses.sort((left, right) => left.clauseId.localeCompare(right.clauseId)
      || left.testSource.localeCompare(right.testSource) || (left.line ?? 0) - (right.line ?? 0)),
    unattachedTags,
    profiles: [...fileProfile.entries()].map(([testSource, entry]) => ({ testSource, ...entry,
      ceiling: testAdapterProfile(entry.profile).ceiling })),
    errors, errorFindings
  };
}

/**
 * Bind each source-bound planned clause to an explicit comment in one of its exact planned
 * product-source paths. The reviewed plan pointer, rather than an arbitrary claims file in the
 * directory, is authority. Test-only and reviewed not-applicable rows have no source-tag duty.
 */
/** Whether this code step delivers a planned obligation: the plan allocates it here, or allocates it nowhere. */
function allocatedTo(claim, phaseId) {
  return !(claim?.steps ?? []).length || claim.steps.includes(phaseId);
}

/** Whether delivering a planned obligation changes the product source that carries its clause. */
function changesProductSource(claim) {
  return (claim.fulfillment == null || SOURCE_CHANGING_FULFILLMENT.includes(claim.fulfillment))
    && plannedProductSourcePaths(claim).length > 0;
}

/**
 * The planned obligations this code step delivers, read from its planning owner's reviewed plan
 * [E2G-009, E2G-010], or null when the Story plans no claims, so the original rules apply.
 */
async function allocatedPlanObligations(root, config, workflow, phase) {
  if (workflow.resolution?.plannedClaims?.mode !== 'required') return null;
  const owner = workflow.phases?.[workflow.resolution.plannedClaims.owners?.[phase.id]];
  if (!owner?.claimMaps?.planned) return null;
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const active = await loadActiveSpecRecords(itemDirectory, workflow);
  const plan = await readBoundSpecificationClaimMap(root, itemDirectory, workflow, owner, 'planned', {
    clauseIds: predecessorSpecClauses(active, workflow, phase.id).map((clause) => clause.id),
    policy: workflow.resolution?.spec ?? config.spec ?? {}
  });
  return Object.entries(plan.claims ?? {})
    .filter(([, claim]) => allocatedTo(claim, phase.id))
    .map(([clauseId, claim]) => ({ clauseId: clauseId.toUpperCase(), ...claim }))
    .sort((left, right) => left.clauseId.localeCompare(right.clauseId));
}

/**
 * The exact planned evidence files this code step owes, under the Story's evidence directory:
 * what its author must produce before publication. Edit permission and routing only, never a pass;
 * an unreadable or absent plan owes nothing here and the publication checks still apply.
 */
export async function plannedEvidencePaths(root, config, workflow, phase) {
  const obligations = await allocatedPlanObligations(root, config, workflow, phase).catch(() => null);
  const prefix = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence/`;
  return [...new Set((obligations ?? []).filter((entry) => entry.fulfillment === 'evidence')
    .flatMap((entry) => entry.expectedPaths ?? [])
    .map((candidate) => path.posix.normalize(String(candidate)))
    .filter((candidate) => candidate.startsWith(prefix) && !candidate.split('/').includes('..')))].sort();
}

/**
 * Judge each allocated obligation that is not delivered by new or modified product source by its
 * own fulfillment [E2G-010]: behaviour that already exists must still be at its paths, removed
 * behaviour must be gone, and a document or configuration change must change exactly its paths.
 */
async function fulfillmentEvidence(root, obligations, changedPaths, deletedPaths) {
  const changed = new Set([...changedPaths, ...deletedPaths]);
  const entries = [];
  const problems = [];
  // Each sentence's identity, in the same order [SDA-AC-022]: the obligation and its exact path.
  const problemFindings = [];
  const problem = (code, clauseId, candidate, sentence) => {
    problems.push(sentence);
    problemFindings.push({ code, path: candidate, value: clauseId });
  };
  for (const obligation of obligations ?? []) {
    if (!['existing', 'removed', 'document', 'configuration', 'evidence'].includes(obligation.fulfillment)) continue;
    const paths = [];
    for (const candidate of obligation.expectedPaths) {
      const secured = await secureRepositoryPath(root, candidate, { label: `Planned ${obligation.fulfillment} path` });
      const present = Boolean(secured.exists && secured.entry?.isFile());
      if (obligation.fulfillment === 'evidence' && present && secured.entry.size > 16 * 1024 * 1024) {
        throw new SingularityFlowError(`Retained evidence ${candidate} exceeds 16 MiB.`, { code: 'CODE_DELIVERY_EVIDENCE_TOO_LARGE' });
      }
      if (['existing', 'evidence'].includes(obligation.fulfillment)) {
        paths.push({ path: candidate, state: present ? 'present' : 'missing',
          sha256: present ? createHash('sha256').update(await readFile(secured.absolute)).digest('hex') : null });
        if (!present) problem(`code.delivery.${obligation.fulfillment}-path-missing`, obligation.clauseId, candidate, `${obligation.clauseId} requires ${obligation.fulfillment}, but ${candidate} does not exist`);
      } else if (obligation.fulfillment === 'removed') {
        paths.push({ path: candidate, state: present ? 'present' : 'absent' });
        if (present) problem('code.delivery.removed-path-present', obligation.clauseId, candidate, `${obligation.clauseId} removes ${candidate}, but it still exists`);
      } else {
        paths.push({ path: candidate, state: changed.has(candidate) ? 'changed' : 'unchanged' });
        if (!changed.has(candidate)) problem(`code.delivery.${obligation.fulfillment}-path-unchanged`, obligation.clauseId, candidate, `${obligation.clauseId} is a ${obligation.fulfillment} change, but ${candidate} did not change`);
      }
    }
    entries.push({ clauseId: obligation.clauseId, fulfillment: obligation.fulfillment, paths });
  }
  return { obligations: entries, problems, problemFindings };
}

export async function plannedSourceClauseBindings(root, config, workflow, phase, sourcePaths, {
  deletedSourcePaths = [], changeSet = null
} = {}) {
  if (workflow.resolution?.codeDelivery?.traceability?.sourceBindings !== 'enforce'
      || phase.sourceBoundary === 'test-automation'
      || workflow.resolution?.plannedClaims?.mode !== 'required') {
    return { mode: 'off', required: [], bindings: [], missing: [] };
  }
  const ownerId = workflow.resolution.plannedClaims.owners?.[phase.id];
  const owner = workflow.phases?.[ownerId];
  if (!owner) {
    throw new SingularityFlowError(
      `Code phase '${phase.id}' has no reviewed planning owner for source clause bindings.`,
      { code: 'SPEC_PLANNED_CLAIM_MAP_REQUIRED' }
    );
  }
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const active = await loadActiveSpecRecords(itemDirectory, workflow);
  const clauseIds = predecessorSpecClauses(active, workflow, phase.id).map((clause) => clause.id);
  const plan = await readBoundSpecificationClaimMap(root, itemDirectory, workflow, owner, 'planned', {
    clauseIds, policy: workflow.resolution?.spec ?? config.spec ?? {}
  });
  const available = new Set(sourcePaths);
  // Only obligations this step delivers by new or modified source carry their clause in that source.
  const required = Object.entries(plan.claims ?? {})
    .filter(([, claim]) => allocatedTo(claim, phase.id) && changesProductSource(claim)
      && claim.testDisposition !== 'not-applicable')
    .map(([rawClauseId, claim]) => {
      const clauseId = normalizeQualifiedClauseId(rawClauseId);
      if (!clauseId) {
        throw new SingularityFlowError(`Planned source clause '${rawClauseId}' is not a qualified ID.`, {
          code: 'CODE_DELIVERY_SOURCE_CLAUSE_ID_INVALID'
        });
      }
      return { clauseId, expectedPaths: plannedProductSourcePaths(claim).sort() };
    })
    .sort((left, right) => left.clauseId.localeCompare(right.clauseId));
  const candidates = [...new Set(sourcePaths)]
    .filter((candidate) => !isAllowedTestAutomationPath(candidate) && !isConfigurationPath(candidate))
    .sort();
  const tagsByPath = new Map();
  for (const relative of candidates) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Planned product source'
    });
    if (!secured.exists || !secured.entry?.isFile()) continue;
    if (secured.entry.size >= MAX_BOUND_SOURCE_BYTES) {
      throw new SingularityFlowError(
        `Planned source '${relative}' is too large for exact clause-comment replay (maximum below 16 MiB). Split the source or use a reviewed test-only/not-applicable plan disposition before publication.`,
        { code: 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE', details: { path: relative } }
      );
    }
    const sourceBytes = await readFile(secured.absolute);
    if (sourceBytes.length >= MAX_BOUND_SOURCE_BYTES) {
      throw new SingularityFlowError(
        `Planned source '${relative}' grew beyond the exact clause-comment replay limit before publication.`,
        { code: 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE', details: { path: relative } }
      );
    }
    tagsByPath.set(relative, scanSourceClauseTags(sourceBytes.toString('utf8'), { sourcePath: relative })
      .filter((tag) => tag.tag === 'clause' && normalizeQualifiedClauseId(tag.clauseId)));
  }
  const approved = new Set(clauseIds.map(normalizeQualifiedClauseId));
  // A tag in one of the Story's own namespaces, the ones its test tags are held to, must name a
  // clause it approved [E2G-011]. In a namespace other Stories share, a changed file may carry an
  // earlier Story's tag, which stays. Without an index only the Work ID is the Story's, as before.
  const criteria = specificationCriteria(active, workflow, config)
    ?? { namespaces: new Set([workflow.workItem.id.toUpperCase()]), sharedNamespaces: new Set() };
  const named = [...tagsByPath].flatMap(([sourcePath, tags]) => tags.map((tag) => ({ ...tag, path: sourcePath })));
  let carried = null;
  const carriedNow = () => (carried ??= carriedTags(root, changeSet, named, 'clause', (candidate) =>
    !isAllowedTestAutomationPath(candidate) && !isDocumentationPath(candidate) && !isConfigurationPath(candidate)));
  const unapproved = named.filter((tag) => !approved.has(tag.clauseId) && storyOwnsTag(criteria, tag.clauseId, carriedNow))
    .map((tag) => ({ code: 'EVIDENCE_CLAUSE_UNAPPROVED', clauseId: tag.clauseId, sourcePath: tag.path, line: tag.line,
      message: `@clause:${tag.clauseId} at ${tag.path}:${tag.line} names a clause this Story has not approved.` }));
  if (unapproved.length) throw new SingularityFlowError(
    `Product source names clauses that this Story has not approved: ${unapproved.map((tag) => `${tag.clauseId} at ${tag.sourcePath}:${tag.line}`).join('; ')}. Correct the tag or revise the specification before publishing.`,
    { code: 'EVIDENCE_CLAUSE_UNAPPROVED', details: { findings: unapproved } }
  );
  const tagged = required.flatMap(({ clauseId, expectedPaths }) => expectedPaths.flatMap((sourcePath) =>
    (tagsByPath.get(sourcePath) ?? [])
      .filter((tag) => tag.clauseId === clauseId)
      .map(({ line, tag }) => ({ clauseId, sourcePath, line, tag }))));
  // Each Story numbers its own clauses in a namespace other Stories share, so there a tag binds this
  // Story's clause only where this Story added it; an earlier Story's tag with the same ID names
  // that Story's clause.
  const shared = tagged.filter((binding) => criteria.sharedNamespaces.has(namespaceOf(binding.clauseId)));
  const pathContext = applicationPathContext(config, workflow);
  const own = shared.length ? await storyAddedTagLines(root, workflow, shared.map((binding) => ({
    path: binding.sourcePath, line: binding.line
  })), 'clause', (candidate) => isApplicationPath(candidate, pathContext)
    && !isAllowedTestAutomationPath(candidate) && !isDocumentationPath(candidate) && !isConfigurationPath(candidate)) : null;
  const othersTags = own ? shared.filter((binding) => !own.has(tagKey(binding.sourcePath, binding.line))) : [];
  const bindings = tagged.filter((binding) => !othersTags.includes(binding));
  const deleted = new Set(deletedSourcePaths);
  for (const { clauseId, expectedPaths } of required) {
    for (const sourcePath of expectedPaths) {
      if (deleted.has(sourcePath) && available.has(sourcePath) && !tagsByPath.has(sourcePath)) {
        bindings.push({ clauseId, sourcePath, line: null, tag: 'deletion' });
      }
    }
  }
  const missing = [];
  for (const entry of required.filter(({ clauseId }) => !bindings.some((binding) => binding.clauseId === clauseId))) {
    const others = othersTags.filter((binding) => binding.clauseId === entry.clauseId)
      .map((binding) => ({ path: binding.sourcePath, line: binding.line }));
    const unchanged = await unchangedClauseTags(root, entry, available);
    missing.push(others.length || unchanged.length ? {
      ...entry, ...(others.length ? { otherStoryTags: others } : {}), ...(unchanged.length ? { unchangedTags: unchanged } : {})
    } : entry);
  }
  return { mode: 'enforce', required, bindings, missing };
}

/**
 * The tags for a missing clause in its planned files that this generation neither changes nor
 * carries. A tag binds only in source the generation delivers, so these bind nothing; naming them
 * keeps the refusal from saying the file lacks a tag it holds. Best effort and read-only.
 */
async function unchangedClauseTags(root, { clauseId, expectedPaths }, delivered) {
  const found = [];
  for (const sourcePath of expectedPaths.filter((candidate) => !delivered.has(candidate))) {
    try {
      const secured = await secureRepositoryPath(root, sourcePath, { label: 'Planned product source' });
      if (!secured.exists || !secured.entry?.isFile() || secured.entry.size >= MAX_BOUND_SOURCE_BYTES) continue;
      found.push(...scanSourceClauseTags((await readFile(secured.absolute)).toString('utf8'), { sourcePath })
        .filter((tag) => tag.tag === 'clause' && normalizeQualifiedClauseId(tag.clauseId) === clauseId)
        .map((tag) => ({ path: sourcePath, line: tag.line })));
    } catch { /* an unreadable planned path names no tag */ }
  }
  return found;
}

/** Where a missing clause's tag already is, in a planned file this generation does not change. */
export function unchangedClauseTagsNote(tags = []) {
  if (!tags.length) return '';
  const where = tags.map((tag) => `${tag.path}:${tag.line}`).join(', ');
  return ` (the tag at ${where} is in a file this generation neither changes nor carries, so it binds nothing here: a clause comment counts in planned source the generation changes, or in the previous generation's unchanged source when a reviewer's return asked only for tests)`;
}

/** Why a tag the Story did not add binds nothing here, said after the tag a step still owes. */
export function otherStoryTagsNote(tags = [], noun = 'clause') {
  if (!tags.length) return '';
  const where = tags.map((tag) => `${tag.path}:${tag.line}`).join(', ');
  return tags.length === 1 ? ` (the tag at ${where} is from before this Story, so it names an earlier Story's ${noun})`
    : ` (the tags at ${where} are from before this Story, so they name an earlier Story's ${noun})`;
}

async function pathEvidence(root, paths, { changeSet = null } = {}) {
  const records = [];
  for (const relative of paths) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Delivery evidence path', allowFinalSymlink: true
    });
    const absolute = secured.absolute;
    const info = secured.entry;
    const current = info?.isSymbolicLink()
      ? { exists: true, size: info.size, sha256: null }
      : await snapshot(absolute);
    const endpoint = changeSet?.entries?.find((entry) => entry.newPath === relative || entry.oldPath === relative) ?? null;
    const gitlink = endpoint?.newPath === relative && endpoint?.newMode === '160000';
    const removed = !current.exists && endpoint?.oldPath === relative && endpoint?.oldObject;
    const baselineKind = endpoint?.oldMode === '160000' ? 'gitlink' : 'blob';
    const baselineVerified = removed
      ? run('git', ['cat-file', '-e', `${endpoint.oldObject}^{${baselineKind === 'gitlink' ? 'commit' : 'blob'}}`], {
        cwd: root, allowFailure: true
      }).status === 0
      : false;
    records.push({
      path: relative,
      kind: isConfigurationPath(relative) ? 'configuration' : isAllowedTestAutomationPath(relative) ? 'test'
        : isDocumentationPath(relative) ? 'documentation' : 'source',
      fileKind: gitlink ? 'gitlink' : !info ? 'missing' : info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'regular-file' : 'non-regular',
      exists: gitlink || current.exists,
      size: gitlink ? null : current.size,
      sha256: gitlink ? endpoint.newObject : current.sha256,
      ...(removed ? {
        verifiedAbsence: baselineVerified,
        baseline: { object: endpoint.oldObject, mode: endpoint.oldMode, kind: baselineKind }
      } : {}),
      ...(gitlink ? { gitlink: { commit: endpoint.newObject, mode: endpoint.newMode } } : {})
    });
  }
  return records;
}

async function validatedReusablePaths(root, candidates, priorEvidence, { role, sourceExtensions = [] }) {
  const prior = new Map((priorEvidence ?? []).map((record) => [record.path, record]));
  const current = await pathEvidence(root, candidates);
  const valid = [];
  for (const record of current) {
    const previous = prior.get(record.path);
    if (role === 'source' && record.fileKind === 'missing' && previous?.fileKind === 'missing'
      && previous.verifiedAbsence === true && previous.baseline?.object) {
      const kind = previous.baseline.kind === 'gitlink' ? 'commit' : 'blob';
      const available = run('git', ['cat-file', '-e', `${previous.baseline.object}^{${kind}}`], {
        cwd: root, allowFailure: true
      }).status === 0;
      if (available) { valid.push(record.path); continue; }
    }
    if (role === 'source' && record.fileKind === 'gitlink' && previous?.fileKind === 'gitlink'
      && record.sha256 === previous.sha256) {
      valid.push(record.path); continue;
    }
    const executable = role !== 'test' || await isExecutableTestSourcePath(root, record.path, { sourceExtensions });
    if (!previous || previous.fileKind !== 'regular-file' || record.fileKind !== 'regular-file'
        || !previous.sha256 || previous.sha256 !== record.sha256 || !executable) {
      throw new SingularityFlowError(
        `Previously recorded ${role} path '${record.path}' is missing, replaced, symbolic, no longer executable, or differs from its prior evidence. Change or restore it in the current generation.`,
        { code: 'CODE_DELIVERY_REUSE_INVALID' }
      );
    }
    valid.push(record.path);
  }
  return valid;
}

function assertPublishedDocumentationBaseline(root, config, workflow, phase, priorCommit) {
  const priorGeneration = Number(phase.generation ?? 0);
  const itemPath = posix(path.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id
  ));
  const receiptPath = posix(path.join(
    itemPath,
    'context', 'code-delivery', `${phase.id}-gen${priorGeneration}.json`
  ));
  const workflowPath = `${itemPath}/workflow.json`;
  if (phase.deliveryEvidence?.receiptPath !== receiptPath
      || Number(phase.deliveryEvidence?.generation) !== priorGeneration) {
    throw new SingularityFlowError(
      'The previous code-delivery receipt is not bound to this phase generation.',
      { code: 'CODE_DELIVERY_REUSE_INVALID' }
    );
  }
  let prior;
  let publishedEvidence;
  try {
    const historical = exactFileAtObject(root, priorCommit, receiptPath, {
      maximumBytes: MAX_BOUND_SOURCE_BYTES
    });
    const historicalWorkflow = exactFileAtObject(root, priorCommit, workflowPath, {
      maximumBytes: MAX_BOUND_SOURCE_BYTES
    });
    if (!historical) throw new Error('receipt is absent from the published commit');
    if (!historicalWorkflow) throw new Error('Story state is absent from the published commit');
    prior = readRecord('code-delivery', historical.toString('utf8')).record;
    publishedEvidence = readRecord('story-workflow', historicalWorkflow.toString('utf8')).record
      .phases?.[phase.id]?.deliveryEvidence;
  } catch (error) {
    throw new SingularityFlowError(
      `The previous code-delivery receipt cannot be verified: ${error.message}`,
      { code: 'CODE_DELIVERY_REUSE_INVALID', cause: error }
    );
  }
  const exactPaths = (left, right) => Array.isArray(left) && Array.isArray(right)
    && canonicalJson(left) === canonicalJson(right);
  if (prior.kind !== 'code-delivery'
      || prior.workId !== workflow.workItem.id || prior.phase !== phase.id
      || Number(prior.generation) !== priorGeneration
      || !['pending-tests', 'ready'].includes(prior.status)
      || !exactPaths(prior.changeSet?.sourcePaths, phase.deliveryEvidence.sourcePaths)
      || !exactPaths(prior.changeSet?.executableTestPaths, phase.deliveryEvidence.testPaths)
      || !exactPaths(publishedEvidence?.paths, phase.deliveryEvidence.paths)
      || !exactPaths(publishedEvidence?.sourcePaths, phase.deliveryEvidence.sourcePaths)
      || !exactPaths(publishedEvidence?.testPaths, phase.deliveryEvidence.testPaths)
      || publishedEvidence?.receiptPath !== receiptPath
      || Number(publishedEvidence?.generation) !== priorGeneration
      || publishedEvidence?.sourceTreeSha256 !== phase.deliveryEvidence.sourceTreeSha256
      || publishedEvidence?.changeSet?.digest !== phase.deliveryEvidence.changeSet?.digest
      || prior.changeSet?.digest !== phase.deliveryEvidence.changeSet?.digest) {
    throw new SingularityFlowError(
      'The previous code-delivery source/test paths or fingerprints differ from the published generation.',
      { code: 'CODE_DELIVERY_REUSE_INVALID' }
    );
  }
}

/** Refuse a code phase before generation state or telemetry is mutated. */
export async function evaluateCodeDeliveryPreflight(root, config, workflow, phase, { strictCoverage = false, ignoreDisputes = false, requireReconciled = false } = {}) {
  if (!phaseRequiresCodeDelivery(phase)) return null;
  excludeAlwaysLocalNames(root);
  if ((phase.writeScope ?? 'artifact-only') !== 'source-and-artifact') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' is a code-generation phase but its write scope does not permit source changes.`,
      { code: 'CODE_DELIVERY_SCOPE_INVALID' }
    );
  }

  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  await verifyWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory });
  const baselineCommit = phase.generationIntent?.baseline?.commit
    ?? workflow.workIntervals.current.sourceBaseCommit;
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: baselineCommit,
    subject: {
      workId: workflow.workItem.id, phase: phase.id, generation: nextPhaseGeneration(phase),
      generationIntentId: phase.generationIntent?.id ?? null
    }
  });
  const guards = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const protectedResult = evaluateStoryProtectedPaths(changeSet, guards, workflow);
  // A protected file main changed reaches this branch when main is merged in. It is main's own
  // reviewed change, not this generation's, and restoring it would undo main (2026-10-28). The
  // Story still runs on its pinned configuration.
  const fromBase = protectedResult.valid ? null : storyMergedBaseChanges(root, config, workflow,
    protectedResult.violations.map((entry) => entry.path));
  if (fromBase) protectedResult.violations = protectedResult.violations.filter((entry) => !fromBase.paths.includes(entry.path));
  if (protectedResult.violations.length) {
    const protectedPaths = [...new Set(protectedResult.violations.map((entry) => entry.path))];
    throw new SingularityFlowError(
      `Generation cannot modify protected process paths: ${protectedPaths.join(', ')}`,
      {
        code: 'CHANGE_SET_POLICY_VIOLATION',
        details: {
          violationKind: 'protected-process-path',
          workId: workflow.workItem.id,
          phase: phase.id,
          paths: protectedPaths,
          diagnosticAction: {
            command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`
          },
          remediation: {
            action: 'restore-protected-paths-to-generation-baseline',
            configurationRoute: 'approved-configuration-authority-outside-story'
          }
        }
      }
    );
  }
  const pathContext = applicationPathContext(config, workflow);
  const allApplicationEntries = changeSet.entries
    .filter((entry) => isApplicationChangeEntry(entry, pathContext));
  // The candidate is what the plan names for this step [E2G-027, D9]. A file no step's plan names
  // stays in the worktree and the tests run without it on a materialized candidate; prose is simply
  // left out. A file another step's plan names belongs to that step's generation, and the tests here
  // would run with it while this generation left it out, so it is refused.
  const scope = await codeCandidateScope(itemDirectory, workflow, phase);
  const entryPaths = (entry) => [entry.oldPath, entry.newPath].filter(Boolean);
  const excludedChanges = scope ? [...new Set(allApplicationEntries.flatMap(entryPaths))].filter((candidate) => !scope.allows(candidate)).sort() : [];
  const outside = scope ? await outsideEveryCandidate(itemDirectory, workflow) : null;
  const unsafeExclusions = excludedChanges.filter((candidate) => scope.unsafe(candidate) && !outside?.(candidate));
  if (unsafeExclusions.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} has changed files another step's plan names, and tests would run with them while this generation left them out: ${unsafeExclusions.join(', ')}. `
      + 'Publish them with the step that owns them, account for them here with singularity-flow decision plan, or move them out of the worktree, then publish again.',
      {
        code: 'GENERATION_EXCLUSIONS_UNSAFE',
        details: {
          phase: phase.id, paths: unsafeExclusions,
          recoveryCommands: unsafeExclusions.slice(0, 3).map((candidate) =>
            `singularity-flow decision plan ${workflow.workItem.id} --add-location <clause>=${candidate} --reason <why>`)
        }
      }
    );
  }
  const unresolved = requireReconciled ? await unreconciledCandidatePaths(root, config, workflow, phase, scope) : [];
  if (unresolved.length) throw new SingularityFlowError(
    `These changed files would be excluded from ${phase.id}: ${unresolved.join(', ')}. Account for Story edits under an approved clause with a narrow plan amendment, or preserve unrelated edits through recovery's confirmed private-copy route. Resolve them here before publication; do not reset Planning or commit them manually.`, {
      code: 'GENERATION_EXCLUDED_CHANGES_UNRESOLVED', details: {
        workId: workflow.workItem.id, phase: phase.id, paths: unresolved, excludedChanges: unresolved,
        priorApprovalsPreserved: true, repairScope: 'current-phase',
        accountingCommand: `singularity-flow decision plan ${workflow.workItem.id} --add-location ${renderPlatformCommand([`<CLAUSE>=${unresolved[0]}`], 'darwin')} --reason <why>`,
        recoveryCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`
      }
    });
  const applicationEntries = scope
    ? allApplicationEntries.filter((entry) => entryPaths(entry).every((candidate) => scope.allows(candidate)))
    : allApplicationEntries;
  const applicationChangeSet = { ...changeSet, entries: applicationEntries };
  const boundaryResult = evaluateSourceBoundary(applicationChangeSet, phase.sourceBoundary, {
    phaseId: phase.id, allowedPath: isAllowedTestAutomationPath
  });
  if (!boundaryResult.valid) {
    throw new SingularityFlowError(
      `Phase ${phase.id} may change test automation only; product-source endpoints are outside its boundary: ${boundaryResult.violations.map((entry) => entry.path).join(', ')}`,
      { code: 'CHANGE_SET_POLICY_VIOLATION' }
    );
  }
  const {changedPaths,changedTestCandidates,deletedPaths,deletedSourcePaths,configurationPaths,changedSourcePaths}=deliveryPathCohorts(applicationEntries);
  const changedEndpointPaths = new Set(applicationEntries.flatMap((entry) =>
    [entry.oldPath, entry.newPath].filter(Boolean)));
  const priorGenerationCommit = phase.generationIntent?.baseline?.previousGenerationCommit ?? null;
  const documentationOnlyCorrection = Number(phase.generation ?? 0) > 0
    && priorGenerationCommit === baselineCommit
    && applicationEntries.length > 0
    && applicationEntries.every((entry) => [entry.oldPath, entry.newPath]
      .filter(Boolean).every(isDocumentationPath));
  if (documentationOnlyCorrection) {
    assertPublishedDocumentationBaseline(root, config, workflow, phase, priorGenerationCommit);
  }
  const sourceExtensions = [...new Set((phase.qualityCommands ?? []).flatMap((command, index) => {
    try { return normalizeExternalCommand(command, index).result?.sourceExtensions ?? []; }
    catch { return []; }
  }))];
  const changedTestPaths = [];
  const supportingTestPaths = [];
  for (const candidate of changedTestCandidates) {
    if (await isExecutableTestSourcePath(root, candidate, { sourceExtensions })) changedTestPaths.push(candidate);
    else if (isSupportingTestResourcePath(candidate)) supportingTestPaths.push(candidate);
  }
  const symlinks = applicationEntries.filter((entry) => entry.newContent?.kind === 'symlink');
  if (symlinks.length && (workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject') === 'reject') {
    throw new SingularityFlowError(
      `Source or test delivery cannot use symbolic links: ${symlinks.map((entry) => entry.newPath).join(', ')}`,
      { code: 'SYMLINK_DELIVERY_FORBIDDEN' }
    );
  }
  const intentRevalidation = Boolean(
    phase.intentAmendmentRevalidation?.id && !phase.intentAmendmentRevalidation?.revalidatedAt
  );
  // A correction generation may exercise acceptance tests delivered by its previous generation
  // without changing their source merely to satisfy the gate. Reuse only the exact governed test
  // paths from the prior receipt. First generations normally introduce/change their
  // tests; the independently authenticated TRP baseline route below is explicit.
  const reusableTestCandidates = Number(phase.generation ?? 0) > 0
    ? (phase.deliveryEvidence?.testPaths ?? []).filter((candidate) => !changedEndpointPaths.has(candidate))
    : [];
  const reusableTestPaths = await validatedReusablePaths(
    root, reusableTestCandidates, phase.deliveryEvidence?.paths, { role: 'test', sourceExtensions }
  );
  // A reviewed pre-feature baseline may supply already-existing test source to the
  // first generation. This only plans the cohort: current execution, exact risk
  // matching, acceptance tags and ordinary source safety remain mandatory below.
  const { qualifiedTrpBaselineTestPaths } = await import('./test-recovery-admission.mjs');
  const baselineTestPaths = await qualifiedTrpBaselineTestPaths(root, config, workflow, phase);
  // Behaviour that already exists is verified by the tests the plan names for it, unchanged
  // [E2G-010]; they run and are checked like any delivered test.
  const obligations = await allocatedPlanObligations(root, config, workflow, phase);
  const existingTestPaths = [];
  for (const candidate of new Set((obligations ?? []).filter((obligation) => obligation.fulfillment === 'existing')
    .flatMap((obligation) => obligation.tests ?? []))) {
    if (changedEndpointPaths.has(candidate) || !isAllowedTestAutomationPath(candidate)) continue;
    const secured = await secureRepositoryPath(root, candidate, { label: 'Planned existing test' });
    if (secured.exists && secured.entry?.isFile() && await isExecutableTestSourcePath(root, candidate, { sourceExtensions })) {
      existingTestPaths.push(candidate);
    }
  }
  const testPaths = [...new Set([...changedTestPaths, ...reusableTestPaths, ...baselineTestPaths, ...existingTestPaths])].sort();
  // A reviewer-returned Testing defect can change only executable tests or their supporting
  // resources. Do not require a fake product-source edit in the new Code generation: reuse the
  // exact prior approved source bytes, but only when the latest open change request was created
  // by the guarded Testing repair route and still binds this Code generation and its old receipt.
  const repairRequest = [...(workflow.changeRequests ?? [])].reverse().find((request) =>
    request.status === 'open' && request.targetPhase === phase.id && request.testingRepair
      && reviewMayReturnToCode(workflow.phases?.[request.sourcePhase], phase));
  const repair = repairRequest?.testingRepair;
  const repairDecision = (workflow.phases?.[repairRequest?.sourcePhase]?.approvals ?? []).find((decision) =>
    decision.decision === 'rejected' && !decision.invalidatedAt
      && decision.target === phase.id && decision.changeRequestId === repairRequest?.id);
  const testOnlyChange = applicationEntries.length > 0
    && applicationEntries.every((entry) => [entry.oldPath, entry.newPath]
      .filter(Boolean).every(isAllowedTestAutomationPath));
  const repairBound = Boolean(repair)
    && Boolean(repairDecision)
    && Number(phase.generation ?? 0) > 0
    && Number(repair.codeGeneration) === Number(phase.generation)
    && repair.codeGenerationCommit === phase.generationCommit
    && String(repair.codeReceiptSha256).replace(/^sha256:/u, '')
      === String(phase.deliveryEvidence?.receiptSha256 ?? '').replace(/^sha256:/u, '')
    && /^sha256:[a-f0-9]{64}$/u.test(repair.confirmation ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(repair.changeSetDigest ?? '')
    && Array.isArray(repair.changedPaths) && repair.changedPaths.length > 0;
  // A confirmed repair whose returned edits were all undone leaves the approved generation exactly
  // as it was: nothing further to change. It carries that generation's source and tests unchanged,
  // runs them again and is reviewed again, as an intent revalidation that changes nothing is.
  const withdrawnRepair = repairBound && !applicationEntries.length;
  const confirmedRepair = repairBound && !changedSourcePaths.length && (testOnlyChange || withdrawnRepair);
  // A reviewer who returned a submitted generation asking only for tests made the same request
  // after submission: its rejection (or reopen) reset exactly this published generation, so the
  // generation is judged as the same test repair. The implementation it carries is the previous
  // generation's exact source bytes, never a claim of new work; a first generation has none.
  const returnRequest = !confirmedRepair && reworkReturnRequest(workflow, phase);
  const reworkRepair = !confirmedRepair && !changedSourcePaths.length && testOnlyChange && Boolean(returnRequest);
  const testOnlyRepair = confirmedRepair || reworkRepair;
  const earlierReturn = !intentRevalidation && !testOnlyRepair && !applicationEntries.length ? earlierReturnRequest(workflow, phase) : null;
  const reusableSourceCandidates = intentRevalidation || testOnlyRepair || documentationOnlyCorrection || earlierReturn
    ? (phase.deliveryEvidence?.sourcePaths ?? []).filter((candidate) =>
      !changedEndpointPaths.has(candidate) && !isDocumentationPath(candidate) && !isConfigurationPath(candidate))
    : [];
  const reusableSourcePaths = await validatedReusablePaths(
    root, reusableSourceCandidates, phase.deliveryEvidence?.paths, { role: 'source' }
  );
  const sourcePaths = [...new Set([...changedSourcePaths, ...reusableSourcePaths])].sort();
  const errors = [];
  // Each sentence is presentation; its identity {code, path, value} (never a line or wording) names
  // the finding a dispute or an escalation matches [SDA-AC-022]. Kept in the same order as errors.
  const identities = [];
  const report = (problem, identity) => { errors.push(problem); identities.push(identity); };
  const reportAll = (problems, findings) => problems.forEach((problem, index) => report(problem, findings[index]));
  // What this step owes comes from its allocated obligations [E2G-010]: existing behaviour changes
  // nothing, and test-only, document, configuration and removal work need no new product source.
  const fulfillment = await fulfillmentEvidence(root, obligations, changedPaths, deletedPaths);
  const changeRequired = !obligations || obligations.some((obligation) => !['existing', 'evidence'].includes(obligation.fulfillment));
  const sourceRequired = !obligations || obligations.some(changesProductSource);

  const unchangedGeneration = !applicationEntries.length && !intentRevalidation && !withdrawnRepair && !earlierReturn && changeRequired;
  if (unchangedGeneration) {
    report('no application source or test paths changed during the work interval', { code: 'code.delivery.generation-unchanged' });
  }
  const implementationMissing = phase.sourceBoundary !== 'test-automation' && !sourcePaths.length && sourceRequired;
  if (implementationMissing) {
    report('no product source path changed; a summary, configuration or test-only edit is not an implementation',
      { code: 'code.delivery.product-source-missing' });
  }
  reportAll(fulfillment.problems, fulfillment.problemFindings);
  const requiredAcIds = await acceptanceIds(root, config, workflow, phase);
  // A test is owed only where the plan plans one. Rows the plan reviewed as needing none (a document,
  // configuration, removal or screenshot row whose tests are not applicable, or one proven by
  // inspection) had only a dated dispute past this, and none at all without approvers (2026-10-28).
  const testsOwed = !obligations || requiredAcIds.length > 0 || obligations.some((obligation) =>
    (obligation.tests ?? []).length > 0 || !['not-applicable', 'non-test'].includes(obligation.testDisposition ?? 'unspecified'));
  if (!testPaths.length && testsOwed) {
    // A file named as a test outside every recognised test folder is counted as product source; say
    // so, or the author keeps re-tagging a test the gate never reads.
    const uncounted = changedPaths.filter((candidate) => !isAllowedTestAutomationPath(candidate) && isTestSourceName(candidate));
    report(uncounted.length
      ? `no acceptance test is available for the implementation: ${uncounted.slice(0, 5).join(', ')}${uncounted.length > 5 ? ` and ${uncounted.length - 5} more` : ''} ${uncounted.length === 1 ? 'is' : 'are'} named as tests but not in a recognised test folder (test, tests, spec, __tests__, e2e, src/<name>Test, <Target>Tests, <Project>.Tests), so ${uncounted.length === 1 ? 'it counts' : 'they count'} as product source`
      : 'no acceptance test is available for the implementation', { code: 'code.delivery.acceptance-test-missing' });
  }

  const criteria = specificationCriteria(await loadActiveSpecRecords(itemDirectory, workflow), workflow, config);
  const scanned = await taggedAcceptanceIds(root, testPaths);
  // In a namespace other Stories share, a test tag names this Story's criterion only where this Story
  // added it: an earlier Story's tag with the same ID neither satisfies nor witnesses it [E2G-015].
  const shared = scanned.locations.filter((location) => criteria?.held.has(location.clauseId)
    && criteria.sharedNamespaces.has(namespaceOf(location.clauseId)));
  const own = shared.length ? await storyAddedTagLines(root, workflow, shared.map((location) => ({
    path: location.testSource, line: location.line
  })), 'ac', (candidate) => isApplicationPath(candidate, pathContext) && isAllowedTestAutomationPath(candidate)) : null;
  const othersTags = own ? shared.filter((location) => !own.has(tagKey(location.testSource, location.line))) : [];
  const tags = othersTags.length ? withoutTags(scanned, othersTags) : scanned;
  const taggedAcIds = tags.ids;
  const missingAcIds = requiredAcIds.filter((id) => !taggedAcIds.includes(id));
  if (missingAcIds.length) {
    report(`changed tests do not contain required traceability tags: ${missingAcIds.map((id) => `@ac:${id}${otherStoryTagsNote(othersTags
      .filter((location) => location.clauseId === id).map((location) => ({ path: location.testSource, line: location.line })), 'criterion')}`).join(', ')}`,
    { code: 'code.delivery.acceptance-tag-missing', value: missingAcIds });
  }
  // A test carries the nearest tag with its ID at or above its line.
  const othersTag = ({ testSource, clauseId, line }) => line != null && othersTags.some((location) =>
    location.testSource === testSource && location.clauseId === clauseId && location.line === Math.max(0, ...scanned.locations
      .filter((candidate) => candidate.testSource === testSource && candidate.clauseId === clauseId && candidate.line <= line)
      .map((candidate) => candidate.line)));
  const witnessDiscovery = await discoverAcceptanceWitnesses(root, phase, {
    testPaths, sourcePaths, requiredAcIds: requiredAcIds.filter((id) => taggedAcIds.includes(id)), bindings: tags.bindings,
    othersTag, executionMode: storyTestScope(workflow)
  });
  reportAll(witnessDiscovery.errors, witnessDiscovery.errorFindings);
  // A tag naming a criterion the specification does not hold is refused while this generation is
  // still editable, not at submission once it has been spent [E2G-015].
  const unknownCriteria = unknownCriterionTags(criteria, {
    locations: tags.locations, witnesses: witnessDiscovery.witnesses, unattachedTags: witnessDiscovery.unattachedTags,
    owed: requiredAcIds,
    carried: (occurrences) => carriedTags(root, applicationChangeSet, occurrences, 'ac', isAllowedTestAutomationPath)
  });
  if (unknownCriteria.length) {
    const named = unknownCriteria.map((finding) => `@ac:${finding.clauseId} at ${finding.path}${finding.line ? `:${finding.line}` : ''}`).join('; ');
    errors.unshift(criteria ? `tests name criteria the active specification does not hold: ${named}`
      : `tests name criteria, but this Story has no specification index, so no test can witness one: ${named}`);
    identities.unshift({ code: 'code.delivery.criterion-tag-unknown', value: unknownCriteria.map((finding) => finding.clauseId) });
  }
  const sourceBindings = await plannedSourceClauseBindings(root, config, workflow, phase, sourcePaths, {
    deletedSourcePaths, changeSet: applicationChangeSet
  });
  // Each obligation delivered in source is bound to its changed hunks and its explanation [E2G-011].
  const bound = sourceBindings.mode === 'enforce' && sourceBindings.required.length
    ? await implementationBindings(root, { changeSet, required: sourceBindings.required, tags: sourceBindings.bindings })
    : null;
  if (bound) reportAll(bound.problems, bound.problemFindings);
  const absentTags = sourceBindings.missing.filter((missing) => !missing.unchangedTags?.length);
  if (absentTags.length) {
    report(`planned product source does not contain required clause comments: ${absentTags
      .map(({ clauseId, expectedPaths, otherStoryTags }) => `@clause:${clauseId} in ${expectedPaths.join(' or ')}${otherStoryTagsNote(otherStoryTags)}`).join('; ')}`,
    { code: 'code.delivery.source-clause-tag-missing', value: absentTags.map((missing) => missing.clauseId) });
  }
  // The file holds the tag, but this generation does not deliver that file: say so, and what counts.
  const undeliveredTags = sourceBindings.missing.filter((missing) => missing.unchangedTags?.length);
  if (undeliveredTags.length) {
    report(`required clause comments are only in planned source this generation does not deliver: ${undeliveredTags
      .map(({ clauseId, unchangedTags }) => `@clause:${clauseId} at ${unchangedTags.map((tag) => `${tag.path}:${tag.line}`).join(', ')}`).join('; ')}`
      + '. A clause comment counts in planned source the generation changes, or in the previous generation\'s unchanged source when a reviewer\'s return asked only for tests',
    { code: 'code.delivery.source-clause-tag-undelivered', value: undeliveredTags.map((missing) => missing.clauseId) });
  }
  const enforceCornerCases = workflow.resolution?.codeDelivery?.cornerCaseObligations === 'enforce'
    || config.governance?.requireCornerCaseCoverage === true;
  const enforceAssertionAdequacy = enforceCornerCases
    || workflow.resolution?.codeDelivery?.assertionAdequacy === 'enforce'
    || config.governance?.requireAssertionAdequacy === true;
  let cornerCaseGate = null;
  if (enforceCornerCases || enforceAssertionAdequacy) {
    const { evaluateDeliveryCornerCaseGate, compactCornerCaseMatrix } = await import(CORNER_CASE_MODULE);
    cornerCaseGate = await evaluateDeliveryCornerCaseGate(root, {
      changeSet, sourcePaths, testPaths, enforceCornerCases, enforceAssertionAdequacy
    });
    reportAll(cornerCaseGate.problems, cornerCaseGate.problemFindings);
    cornerCaseGate.compactMatrix = compactCornerCaseMatrix(cornerCaseGate.matrix);
  }
  // The step's approvers may accept these exact problems for this exact candidate as a disputed
  // finding [recoverable-findings M2]; anything else, or any change, still refuses.
  const candidateSha256 = errors.length ? (await import('./phase-finding-dispute.mjs')).codeDeliveryCandidateSha256(applicationEntries) : null;
  // Loaded only on a refusal, like the dispute module, so no passing gate pays for it.
  const { canonicalFinding } = errors.length ? await import('./finding-identity.mjs') : {};
  const findings = errors.length ? identities.map((identity) => canonicalFinding(identity)) : [];
  const acceptedDispute = errors.length && !unknownCriteria.length && !ignoreDisputes
    ? (await (await import('./phase-finding-dispute.mjs')).codeDeliveryDisputeStatus(root, config, workflow, phase,
      { problems: errors, findings, candidateSha256 })).active : null;
  if (errors.length && !acceptedDispute) {
    const unknown = unknownCriteria.length > 0;
    // Without an index, a criterion the step owes is named only by an earlier artifact's text, so no
    // tag edit can make its exactly read test reviewable.
    const owedUnknown = [...new Set(unknownCriteria.map((finding) => finding.clauseId))].filter((id) => requiredAcIds.includes(id));
    const correction = criteria
      ? `Correct each @ac tag to a criterion the specification holds${requiredAcIds.length ? ` (this step owes ${requiredAcIds.join(', ')})` : ''}, or remove it; a criterion it lacks needs a revised specification first.`
      : owedUnknown.length
        ? `${unknownCriteria.some((finding) => !owedUnknown.includes(finding.clauseId)) ? 'Remove each @ac tag the step does not owe. ' : ''}`
          + `A criterion the step owes but no specification index defines (${owedUnknown.join(', ')}) cannot be witnessed by an exactly read test; the Story needs an indexed specification first (singularity-flow explain governance-rebuild).`
        : 'Remove each @ac tag: this Story defines no criteria for a test to witness.';
    const deliveryRoute = unknown ? null : testOnlyDeliveryRoute(workflow, phase, {
      unchanged: unchangedGeneration, testOnly: testOnlyChange && implementationMissing
    });
    throw new SingularityFlowError(
      `Phase ${phase.id} has no publishable code delivery:\n- ${errors.join('\n- ')}\n`
      + (deliveryRoute ? deliveryRoute.guidance
        : !unknown ? 'Implement the approved behavior, add acceptance-mapped tests, and publish again.'
        : `${correction}${errors.length > 1 ? ' Resolve the other findings too, then publish again.' : ' Then publish again.'}`),
      {
        code: unknown ? 'EVIDENCE_CRITERION_UNKNOWN' : 'CODE_DELIVERY_EVIDENCE_REQUIRED',
        details: {
          ...(unknown ? {
            phase: phase.id, findings: unknownCriteria, paths: [...new Set(unknownCriteria.map((finding) => finding.path))],
            recoveryCommands: [`singularity-flow phase prepublish ${phase.id} --json`]
          } : {}),
          sourceBindingsMissing: sourceBindings.missing, explanationsMissing: bound?.explanationsMissing ?? [],
          // The route a refused test-only or unchanged generation takes, never a fake source edit.
          ...(deliveryRoute ? { deliveryRoute } : {}),
          ...(deliveryRoute?.command ? { nextAction: { command: deliveryRoute.command, skill: deliveryRoute.skill,
            label: `If no change is needed, a reviewer of the returning step previews withdrawing ${deliveryRoute.changeRequestId}.` } } : {}),
          ...(cornerCaseGate?.findings?.length ? { cornerCaseFindings: cornerCaseGate.findings,
            cornerCaseHarness: cornerCaseGate.harness } : {}),
          // The exact problems and candidate a dispute would bind to (appeal risk-prepare --finding),
          // and each problem's canonical identity in the same order; an unknown criterion keeps its
          // own findings, so only its IDs are added.
          ...(!unknown ? { problems: [...errors], findings, candidateSha256 } : {}),
          findingIds: findings.map((finding) => finding.id),
          // Each planned evidence file this step owes but has not produced, so recovery can name
          // the file and its route instead of a prose-only shortfall.
          retainedEvidenceMissing: fulfillment.obligations.filter((entry) => entry.fulfillment === 'evidence')
            .flatMap((entry) => entry.paths.filter((item) => item.state === 'missing')
              .map((item) => ({ clauseId: entry.clauseId, path: item.path }))),
          problemCount: errors.length,
          // Read-only repair input, derived from the verified planning pointer and candidate.
          // Do not select a test/function by guessing from a file name or invent its meaning.
          traceabilityRepair: {
            plan: workflow.phases?.[workflow.resolution?.plannedClaims?.owners?.[phase.id]]?.claimMaps?.planned ?? null,
            sourcePaths, testPaths,
            actions: [
              ...sourceBindings.missing.map((missing) => ({
                kind: 'source-tag', clauseId: missing.clauseId, approved: true,
                expectedPaths: missing.expectedPaths,
                regions: bound?.bindings.find((binding) => binding.clauseId === missing.clauseId)?.regions ?? []
              })),
              ...(bound?.explanationsMissing ?? []).filter((missing) => missing.path).map((missing) => ({
                kind: 'clause-explanation', clauseId: missing.clauseId, approved: true,
                expectedPaths: [missing.path], line: missing.line,
                regions: bound?.bindings.find((binding) => binding.clauseId === missing.clauseId)?.regions ?? []
              })),
              ...missingAcIds.map((clauseId) => ({
                kind: 'acceptance-tag', clauseId, approved: Boolean(criteria?.held.has(clauseId)),
                expectedPaths: obligations?.find((obligation) => obligation.clauseId === clauseId)?.tests ?? []
              })),
              ...witnessDiscovery.unattachedTags.flatMap((tag) => tag.clauseIds
                .filter((clauseId) => requiredAcIds.includes(clauseId)).map((clauseId) => ({
                  kind: 'acceptance-attachment', clauseId, approved: Boolean(criteria?.held.has(clauseId)),
                  expectedPaths: obligations?.find((obligation) => obligation.clauseId === clauseId)?.tests
                    .filter((candidate) => candidate === tag.testSource) ?? [],
                  line: tag.line
                })))
            ]
          }
        }
      }
    );
  }

  const delivery = {
    requirement: 'source-and-tests',
    baselineCommit,
    generationIntentId: phase.generationIntent?.id ?? null,
    changeSet,
    changeClassification: classifyDeliveryChanges(changeSet, {
      generatedRoots: workflow.resolution?.ast?.generatedRoots ?? config.ast?.generatedRoots ?? [],
      pathContext
    }),
    paths: await pathEvidence(root, [...new Set([
      ...changedPaths, ...deletedPaths, ...reusableSourcePaths, ...reusableTestPaths, ...baselineTestPaths, ...existingTestPaths
    ])].sort(), { changeSet }),
    sourcePaths,
    configurationPaths,
    deletedSourcePaths: [...new Set(deletedSourcePaths)].sort(),
    testPaths,
    supportingTestPaths,
    documentationCorrection: documentationOnlyCorrection ? {
      priorGeneration: Number(phase.generation),
      priorGenerationCommit,
      changedPaths: [...new Set(applicationEntries.flatMap((entry) =>
        [entry.oldPath, entry.newPath].filter(Boolean)))].sort(),
      reusedSourcePaths: reusableSourcePaths,
      reusedTestPaths: reusableTestPaths
    } : null,
    intentRevalidation: intentRevalidation ? phase.intentAmendmentRevalidation.id : null,
    ...(earlierReturn ? { earlierReturn: { changeRequestId: earlierReturn.id, targetPhase: earlierReturn.targetPhase, priorGeneration: Number(phase.generation) } } : {}),
    testingRepair: confirmedRepair ? {
      changeRequestId: repairRequest.id,
      priorGeneration: repair.codeGeneration,
      priorReceiptSha256: repair.codeReceiptSha256,
      reusedSourcePaths: reusableSourcePaths
    } : reworkRepair ? {
      changeRequestId: returnRequest.id,
      priorGeneration: Number(phase.generation),
      priorReceiptSha256: phase.deliveryEvidence.receiptSha256,
      reusedSourcePaths: reusableSourcePaths
    } : null,
    acceptanceCriteria: {
      required: requiredAcIds, tagged: taggedAcIds, missing: [], ambiguous: [],
      inferred: tags.inferred, bindings: tags.bindings,
      witnesses: witnessDiscovery.witnesses, unattachedTags: witnessDiscovery.unattachedTags,
      profiles: witnessDiscovery.profiles
    },
    sourceBindings,
    excludedChanges,
    fulfillment: fulfillment.obligations,
    implementationBindings: bound ? { bindings: bound.bindings, bindingsSha256: bound.bindingsSha256 } : null,
    ...(cornerCaseGate?.matrix ? { cornerCaseMatrix: cornerCaseGate.compactMatrix } : {})
  };
  // Shown to whoever reads the result; not serialized into the delivery receipt, whose record
  // family is versioned separately. The dispute itself is the retained, reviewed record.
  if (acceptedDispute) Object.defineProperty(delivery, 'acceptedDispute', { value: acceptedDispute });
  // The preview loads bound Story records; defer that dependency until the kernel is initialized.
  const { assertCandidateSpecificationCoverage, assertStrictCandidateSpecificationCoverage } = await import('./spec-coverage-preview.mjs');
  try { await (strictCoverage ? assertStrictCandidateSpecificationCoverage : assertCandidateSpecificationCoverage)(root, config, workflow, phase, delivery); }
  catch (error) {
    // Internal candidate bytes are used to bind risk, not serialized into CLI errors or reports.
    if (error.code === 'SPEC_COVERAGE_INCOMPLETE') Object.defineProperty(error, 'qualityRiskCandidate', { value: delivery });
    throw error;
  }
  return delivery;
}

function commandText(command) {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.join(' ');
  if (Array.isArray(command?.argv)) return command.argv.join(' ');
  return String(command?.command ?? '');
}

function commandTokens(command) {
  if (Array.isArray(command)) return command.map(String);
  if (Array.isArray(command?.argv)) return command.argv.map(String);
  return commandText(command).trim().split(/\s+/).filter(Boolean);
}

function executableName(value) {
  return path.basename(String(value ?? '')).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
}

/** A code receipt must execute tests; lint/compile/diff commands alone are not sufficient. */
export function isTestQualityCommand(command) {
  if (command && typeof command === 'object' && !Array.isArray(command) && command.kind != null) {
    return command.kind === 'test';
  }
  const [rawExecutable, ...rawArguments] = commandTokens(command);
  const executable = executableName(rawExecutable);
  const args = rawArguments.map((argument) => argument.toLowerCase());
  const hasTask = (names) => args.some((argument) => names.has(argument.replace(/^.*:/, '')));

  if (['mvn', 'mvnw'].includes(executable)) return hasTask(new Set(['test', 'verify', 'integration-test']));
  if (['gradle', 'gradlew'].includes(executable)) return hasTask(new Set(['test', 'check']));
  if (['go', 'cargo', 'dotnet', 'swift'].includes(executable)) return args[0] === 'test';
  if (['pytest', 'jest', 'vitest', 'mocha'].includes(executable)) return true;
  if (['python', 'python3', 'py'].includes(executable)) {
    return args.some((argument, index) => argument === '-m' && ['pytest', 'unittest'].includes(args[index + 1]));
  }
  if (executable === 'node') return args.some((argument) => argument === '--test' || argument.startsWith('--test='));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (args[0] === 'test') return true;
    const script = args[0] === 'run' ? args[1] : args[0];
    return /(^|[:_-])(test|tests|acceptance|e2e|integration|unit)(?:$|[:_.-])/.test(script ?? '');
  }
  if (['npx', 'pnpx', 'yarnx', 'bunx'].includes(executable)) {
    const packageIndex = args.findIndex((argument) => !argument.startsWith('-'));
    const runner = executableName(args[packageIndex]);
    const runnerArgs = args.slice(packageIndex + 1);
    if (['jest', 'vitest', 'mocha'].includes(runner)) return true;
    if (runner === 'playwright') return runnerArgs.includes('test');
  }
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    return /(^|[._-])(test|tests|acceptance|e2e)(?:[._-]|$)/.test(executableName(args[0]));
  }
  return /(^|[._-])(test|tests|acceptance|e2e)(?:[._-]|$)/.test(executable);
}

/** Where a step's test command came from: a person's Story-only decision, approved configuration, or inference. */
export function testCommandProvenance(phase, command) {
  return command?.storyDecision ? 'story-decision' : (phase.qualityCommands ?? []).includes(command) ? 'configured' : 'inferred';
}

const configuredStepTests = (phase) => [...(phase.qualityCommands ?? []), ...(phase.storyTestCommands ?? [])].filter((command) =>
  command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test');

// Whether one of `tests` covers a module root through its affected roots.
const configuredTestOwner = (tests) => (moduleRoot) => tests.some((command) =>
  (command.affectedRoots ?? []).some((candidate) => {
    const prefix = posix(candidate ?? '').replace(/^\.\//, '') || '.';
    return prefix === '.' || moduleRoot === prefix || moduleRoot.startsWith(`${prefix}/`);
  }));

/** The modules a step's changed paths belong to, and whether a configured test owns a module root; the gate and its removed-suite check share it. */
export async function affectedTestModules(root, phase) {
  const tests = configuredStepTests(phase);
  const ownedByConfiguredTest = configuredTestOwner(tests);
  const deliveryPaths = [...new Set([
    ...(phase.deliveryEvidence?.sourcePaths ?? []),
    ...(phase.deliveryEvidence?.configurationPaths ?? []),
    ...(phase.deliveryEvidence?.testPaths ?? [])
  ])];
  const modules = new Map();
  // An approved configured test command owns the paths below its affected roots, so a directory
  // with two build systems (a tooling package.json beside pom.xml) is decided by that approval.
  const overrides = configuredTestModuleOverrides(tests);
  const { results: resolvedModules } = await runBoundedTaskPool(deliveryPaths, candidate =>
    resolveAffectedModule(root, candidate, { overrides }).catch((error) => {
      // Repository metadata and CI configuration need no module of their own [testCoverageExemptPath].
      if (testCoverageExemptPath(candidate) && ['TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS'].includes(error?.code)) return null;
      // A build with no supported runner owns its files: refuse rather than borrow another module's tests.
      if (error?.code === 'TEST_MODULE_UNCOVERED' && !error.details?.nativeManifest) return null;
      throw error;
    }));
  for (const module of resolvedModules) {
    if (module?.configured) continue;
    if (module) modules.set(`${module.root}:${module.system}`, module);
  }
  return { modules: [...modules.values()], ownedByConfiguredTest };
}

export async function resolveDeliveryQualityCommands(root, phase, { executionMode = 'changed-and-affected' } = {}) {
  // Commands a step approver accepted for this Story only (src/story-test-commands.mjs) run like configured ones.
  const configured = [...(phase.qualityCommands ?? []), ...(phase.storyTestCommands ?? [])];
  if (!phaseRequiresCodeDelivery(phase)) return configured;
  const configuredTests = configuredStepTests(phase);
  const moduleCoveredByConfiguredTest = configuredTestOwner(configuredTests);
  const inferred = [];
  if (executionMode === 'all-configured') {
    // Explicit broad scope: include the repository-native suite as well as affected modules.
    // Do not recursively scan an arbitrarily large monorepo to guess additional runners.
    inferred.push(...(await inferRepositoryTestCommands(root)).filter(command =>
      !moduleCoveredByConfiguredTest(command.workingDirectory ?? '.')));
  }
  const { modules } = await affectedTestModules(root, phase);
  for (const module of modules) {
    // Each runner and level a module declares (unit, end-to-end, component) is its own run [TCE:REQ-071].
    if (!moduleCoveredByConfiguredTest(module.root)) inferred.push(...await (await import('./test-module-markers.mjs')).moduleTestCommands(root, module));
  }
  // A recognized changed module with no supported runner must not borrow an unrelated root
  // manifest's passing tests as its own execution evidence.
  if (!inferred.length && !configuredTests.length && !modules.length) {
    inferred.push(...await inferRepositoryTestCommands(root));
  }
  if (!inferred.length && !configuredTests.length) {
    const tests = phase.deliveryEvidence?.testPaths ?? [];
    if (tests.length && tests.every((candidate) => /\.(?:c|m)?js$/i.test(candidate))) {
      // `node --test` is evidence only for node:test files [TCE:REQ-054].
      await (await import('./test-module-markers.mjs')).assertNodeTestFiles(root, tests);
      inferred.push({
        id: 'node-tests', kind: 'test',
        argv: ['node', '--test', ...tests],
        workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
        result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1 }
      });
    } else if (tests.length && tests.every((candidate) => /\.[cm]?tsx?$/i.test(candidate))) {
      await (await import('./test-plan.mjs')).assertNoUnreadRunner(root, tests);
    }
  }
  const commandKey = command => JSON.stringify([commandText(command), command?.workingDirectory ?? '.']);
  const seen = new Set(configured.map(commandKey));
  // A module reached by its own path and from the reactor above it is one run, the one that also answers for the reactor's files.
  const widest = new Map();
  for (const command of inferred) {
    if (command && !((widest.get(commandKey(command))?.affectedRoots?.length ?? 0) >= (command.affectedRoots?.length ?? 1))) widest.set(commandKey(command), command);
  }
  return [...configured, ...inferred.filter((command) => {
    if (!command || seen.has(commandKey(command))) return false;
    seen.add(commandKey(command));
    return true;
  }).map((command) => widest.get(commandKey(command)) ?? command)];
}

function receiptDigest(record) {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

/** Optional immutable read-ahead only; hashes, schemas and verdicts are still checked on replay. */
function prefetchTestReplay(root, evidenceCommit, executions) {
  const empty = () => ({ receipts: new Map(), records: new Map(), reports: new Map() });
  if (!evidenceCommit || !Number.isSafeInteger(SUBPROCESS_MAX_BUFFER_BYTES) || SUBPROCESS_MAX_BUFFER_BYTES <= 0) return empty();
  const maximumObjectBytes = Math.min(16 * 1024 * 1024, SUBPROCESS_MAX_BUFFER_BYTES);
  const regular = executions.filter(execution => execution.kind !== 'phase-validation-observation');
  const receipts = prefetchExactObjectFiles(root, evidenceCommit,
    regular.map(execution => execution.receiptPath).filter(safeEvidencePath), { maximumObjectBytes });
  const records = new Map();
  const paths = new Set();
  for (const execution of regular) {
    const bytes = receipts.get(execution.receiptPath);
    if (!bytes) continue;
    try {
      let record = records.get(execution.receiptPath);
      if (!records.has(execution.receiptPath)) {
        record = JSON.parse(bytes.toString('utf8'));
        records.set(execution.receiptPath, record);
      }
      // Do not discover paths from an unbound or malformed record. This is not test acceptance:
      // the original replay below still checks identity, candidate, adapter results and policy.
      if (receiptDigest(record) !== String(execution.receiptSha256 ?? '').replace(/^sha256:/u, '')) continue;
      const testReceipt = readRecord('test-execution', record).record;
      const extension = ['junit-xml', 'dotnet-trx'].includes(testReceipt.adapter) ? '.xml' : '.bin';
      for (const report of testReceipt.rawReports ?? []) {
        if (safeEvidencePath(report.path) && /^[0-9a-f]{64}$/u.test(report.sha256 ?? '')
            && Number.isInteger(report.bytes) && report.bytes >= 0 && report.bytes <= maximumObjectBytes
            && report.path.includes('/context/code-delivery/tests/raw/')
            && report.path.endsWith(`/${report.sha256}${extension}`)) paths.add(report.path);
      }
    } catch { /* malformed/unavailable records take their ordinary diagnostic route below */ }
  }
  return { receipts, records, reports: prefetchExactObjectFiles(root, evidenceCommit, [...paths], { maximumObjectBytes }) };
}

/**
 * Re-verify the durable code-delivery receipt without consulting current source bytes.
 * Source policy is replayed from the change set committed with the generation; test receipts are
 * hash-bound by the ready receipt written at submission.
 */
export async function verifyCodeDeliveryReceipt(root, receipt, {
  protectedPaths = [],
  configurationSource = null,
  sourceBoundary = 'unrestricted',
  symlinkPolicy = 'reject',
  minimumDiscovered = 1,
  minimumPassed = 1,
  requireAffectedModuleCoverage = true,
  minimumModelAssurance = 'unavailable',
  sourceBindingPolicy = 'off',
  cornerCasePolicy = 'off',
  assertionAdequacyPolicy = 'off',
  evidenceCommit = null,
  pathContext = null,
  testRecovery = null,
  // { workflow, at }: the Story, for test-run risks and the pins its attempts ran under.
  testRunRisks = null
} = {}) {
  const plan=codeDeliveryReceiptReplay(receipt,{protectedPaths,configurationSource,sourceBoundary,symlinkPolicy,
    minimumDiscovered,minimumPassed,requireAffectedModuleCoverage,minimumModelAssurance,sourceBindingPolicy,
    cornerCasePolicy,assertionAdequacyPolicy,evidenceCommit,pathContext,testRecovery,testRunRisks});
  let generationFiles=new Map(),replayFiles={receipts:new Map(),records:new Map(),reports:new Map()};
  const read=async request=>{
    switch(request.kind){
      case 'generation-tree':return run('git',['rev-parse','--verify',`${request.generationCommit}^{tree}`],{cwd:root,allowFailure:true});
      case 'change-set':return run('git',['show',`${request.generationCommit}:${request.path}`],{cwd:root,allowFailure:true});
      case 'decode-record':return readRecord(request.family,request.value).record;
      case 'prepare-generation-files':generationFiles=prefetchExactObjectFiles(root,request.generationCommit,request.paths);return;
      case 'generation-file':{
        const bytes=generationFiles.get(request.path),options=request.options;
        return !options.regularOnly&&bytes&&bytes.length<=(options.maximumBytes??1024*1024)
          ?bytes:exactFileAtObject(root,request.generationCommit,request.path,options);
      }
      case 'javascript-declarations':return scanJavaScriptDeclarations(request.source,{sourcePath:request.sourcePath,framework:request.framework});
      case 'source-clause-tags':return scanSourceClauseTags(request.source,{sourcePath:request.sourcePath});
      case 'prepare-test-replay':replayFiles=prefetchTestReplay(root,request.evidenceCommit,request.executions);return;
      case 'test-receipt':{
        const prefetched=replayFiles.receipts.get(request.path);
        const source=request.evidenceCommit&&!prefetched?run('git',['show',`${request.evidenceCommit}:${request.path}`],{cwd:root,allowFailure:true,encoding:'buffer'}):null;
        if(source&&source.status!==0)throw new Error(`not present in evidence commit ${request.evidenceCommit}`);
        const storedBytes=prefetched??(source?source.stdout:await readDurableTestObservation(root,request.path));
        return replayFiles.records.has(request.path)?replayFiles.records.get(request.path)
          :JSON.parse(Buffer.isBuffer(storedBytes)?storedBytes.toString('utf8'):storedBytes);
      }
      case 'test-report':{
        const prefetched=replayFiles.reports.get(request.path);if(prefetched)return prefetched;
        if(request.evidenceCommit){
          const raw=run('git',['show',`${request.evidenceCommit}:${request.path}`],{cwd:root,allowFailure:true,encoding:'buffer'});
          if(raw.status!==0)throw new Error(`not present in evidence commit ${request.evidenceCommit}`);return raw.stdout;
        }
        return readDurableTestObservation(root,request.path,{expectedSha256:request.sha256,expectedBytes:request.bytes});
      }
      case 'prepare-report-reader':return prepareCodeDeliveryReportReader(request.adapter);
      case 'auto-candidate':return validateAutoCandidateBinding(request.value);
      case 'auto-verification':return validateAutoCandidateVerification(request.value);
      case 'auto-resource-delta':return applicationChangeSetProjection(buildRepositoryTreeChangeSet(root,{
        baseTree:request.baseTree,targetTree:request.targetTree,subject:request.subject}),request.pathContext);
      case 'auto-resource-digest':return autoCandidateResourceDigest(request.changeSet,{baselineTree:request.baselineTree,candidateSha256:request.candidateSha256});
      case 'test-recovery-context':return (await import('./test-recovery-runtime.mjs')).assertStoryTestRiskGate(root,request.config,request.workflow,request.options);
      case 'test-recovery-commands':return resolveDeliveryQualityCommands(root,request.phase,{executionMode:storyTestScope(request.workflow)});
      case 'test-command-pin-problems':return (await import('./test-command-pins.mjs')).attemptReplayProblems(request.testRunRisks,request.receipt,request.execution,request.testReceipt);
      case 'test-run-risk-problem':return (await import('./test-run-risk.mjs')).testRunRiskCoverageProblem(request.workflow,request.risk,request.options);
      default:throw new SingularityFlowError('Unknown code-delivery evidence request.',{code:'ENGINE_PORT_REQUEST_INVALID'});
    }
  };
  let step=plan.next();
  while(!step.done){
    let value;
    try{value=await read(step.value);}catch(error){step=plan.throw(error);continue;}
    step=plan.next(value);
  }
  return step.value;
}
