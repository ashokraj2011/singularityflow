import {discoverAcceptanceWitnessesReplay,codeDeliveryReceiptReplay,codeDeliveryPreflightReplay,plannedSourceClauseBindingsReplay,carriedTagIdsReplay,storyTagLinesReplay,changesProductSource,codeDeliveryEvidencePath as safeEvidencePath,prepareCodeDeliveryReportReader} from './engine-compatibility/node-source-policy.mjs';
import {gitTagLineDeltas} from './git-status-detail.mjs';
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
import {pinnedTestEvidenceSource, reviewCodeSource, reviewMayReturnToCode, reviewRepairTarget, reviewOwnRepairBoundary,codeDeliveryRepairRoute} from './kernel/phase-policy.mjs';
export {reviewCodeSource,reviewMayReturnToCode,reviewRepairTarget,reviewOwnRepairBoundary} from './kernel/phase-policy.mjs';
import {specificationCriteria, namespaceOf, tagKey,unknownCriterionTags,plannedClaimAllocatedTo as allocatedTo} from './kernel/specification-policy.mjs';
export {specificationCriteria,unknownCriterionTags} from './kernel/specification-policy.mjs';
import {unchangedClauseTagsNote,otherStoryTagsNote} from './kernel/code-delivery-evidence.mjs';
export {unchangedClauseTagsNote,otherStoryTagsNote} from './kernel/code-delivery-evidence.mjs';
import {
  configuredTestModuleOverrides, isAllowedTestAutomationPath, isExecutableTestSourcePath,
  persistedOccurrences, prepareTestReportReader, readDurableTestObservation, replayTestReports,
  resolveAffectedModule
} from './code-delivery-tests.mjs';
import {
  buildRepositoryChangeSet, buildRepositoryTreeChangeSet, evaluateSourceBoundary
} from './repository-change-set.mjs';
import {
  autoCandidateResourceDigest, validateAutoCandidateBinding,
  validateAutoCandidateVerification
} from './auto/auto-candidate.mjs';
import { committedFilesAtRevisions, exactChangedPathsBetweenObjects, exactFileAtObject, isAncestor, prefetchExactObjectFiles } from './git.mjs';
import { canonicalJson } from './foundation/record-schema.mjs';
import { configurationPathKind, isConfigurationPath } from './engine-compatibility/node-source-policy.mjs';
import { normalizeExternalCommand } from "./engine-compatibility/node-configuration-path.mjs";
import { readRecord } from './schema-migrations.mjs';
import {
  loadActiveSpecRecords, mergePlannedClaimRecords, predecessorSpecClauses,
  readBoundSpecificationClaimMap, plannedProductSourcePaths
} from './specifications.mjs';
import {
  discoverDeclarations, profileForCommand, profileIsExact, testAdapterProfile
} from './verification/adapters.mjs';
import { normalizeQualifiedClauseId } from './foundation/traceability-ids.mjs';
import { scanSourceClauseTags } from './source-clause-tags.mjs';
import { codeCandidateScope, outsideEveryCandidate, unreconciledCandidatePaths } from './candidate-scope.mjs';
import { crossPhaseChange, describeCrossPhaseChange } from './evidence/cross-phase-change.mjs';
import {contractRequiresTestTag,effectiveContract,mergedVerificationContracts} from './engine-compatibility/node-specification-policy.mjs';
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

/**
 * The route a refused test-only or unchanged code generation takes, or null. A first generation
 * must implement; a later one carries its previous generation's unchanged source only when a
 * person's return reopened it; one left unchanged after a return is withdrawn by that return's
 * reviewers, which restores the generation it returned. Never a fake product-source edit.
 */
function testOnlyDeliveryRoute(workflow, phase, { unchanged, testOnly }) {
  const workId = workflow.workItem.id;
  const route=codeDeliveryRepairRoute(workflow,phase,{unchanged,testOnly});
  if(!route)return null;
  const generation=route.generation;
  const request=route.changeRequestId?{id:route.changeRequestId,sourcePhase:route.sourcePhase}:null;
  // Withdrawal fits a return made over clean work. A confirmed repair's checkpoint holds the
  // review's own edits, which withdrawing would bring back; left unchanged, it publishes instead.
  if (route.kind === 'withdraw-return') {
    const command = `singularity-flow story rework roll-forward --work-id ${workId} --change-request ${request.id} --json`;
    return Object.freeze({
      kind: 'withdraw-return', changeRequestId: request.id, command, skill: '/sf-reject',
      guidance: `Nothing changed since generation ${generation}, which ${request.id} returned to ${phase.id}. Make the change it asks for, then publish again. `
        + `If no change is needed, a reviewer of ${request.sourcePhase} withdraws the return instead; that restores generation ${generation} and ${request.sourcePhase} as they stood before ${request.id}, and keeps the history. `
        + `Review its preview, then use the --confirm form it prints.\n${formatCommandRouteLines({ command, copilotCommand: '/sf-reject' }).join('\n')}`
    });
  }
  if (route.kind === 'first-generation') {
    const owner = route.owner;
    return Object.freeze({
      kind: 'first-generation', command: null, skill: null,
      guidance: `This is ${phase.id}'s first generation, so a test-only change implements nothing: deliver the approved behavior in its planned product source, with each clause comment in that change, and publish again. `
        + 'Only a later generation that a reviewer returned asking for tests carries earlier source unchanged. '
        + `If a clause truly needs only tests, the plan that owes source for it is what is wrong: raise it against ${owner}, whose approvers correct the row's Fulfillment (test-only, or existing where the behavior already lives). `
        + `\n${formatCommandRouteLines({ copilotCommand: '/sf-decide', command: `singularity-flow upstream-issue raise --work-id ${workId} --phase ${owner} --about <CLAUSE-ID> --problem "<TEXT>"` }).join('\n')}`
    });
  }
  const why = route.reason === 'no-return' ? `no return into ${phase.id} is open`
    : route.reason === 'decision-loop' ? `${request.id} is decision '${route.decisionId}' going round again, not a person's return`
      : `${request.id} did not reopen generation ${generation}`;
  return Object.freeze({
    kind: 'return-required', changeRequestId: request?.id ?? null, command: null, skill: null,
    guidance: `A test-only change carries generation ${generation}'s unchanged source only in a generation that a reviewer's rejection (reject <step> --to ${phase.id}) or a confirmed review repair returned to ${phase.id}; ${why}. `
      + 'Change the planned product source the correction needs, with its clause comments, and publish again.'
  });
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

/**
 * The tags of one kind (`clause` or `ac`) that the generation's files already carried at its
 * baseline [E2G-011, E2G-015]: every tag in a file it left unchanged, and every tag in the baseline
 * version of each file it changed, renamed, copied or deleted, so a tag that moves with its code is
 * carried too. `occurrences` are the tags read now, each with its `path`; the shared rule selects
 * the changed paths worth reading. Without a change set, no tag is known to be carried.
 */
function carriedTags(root,changeSet,occurrences,tag) {
  const replay=carriedTagIdsReplay({baseline:changeSet?.base?.commit??null,changes:(changeSet?.entries??[]).map(entry=>({
    oldPath:entry.oldPath??null,newPath:entry.newPath??null,previousRegular:/^100/u.test(entry.oldMode??'')})),occurrences,tag});let value;
  for(;;) {
    const step=replay.next(value);if(step.done)return step.value;const request=step.value;
    switch(request.kind) {
      case 'origin-baseline-texts':value=new Map([...committedFilesAtRevisions(root,request.paths.map(path=>({key:path,ref:request.baseline,path})),{
        maximumObjectBytes:request.maximumObjectBytes,maximumBytes:request.maximumBytes})].map(([path,bytes])=>[path,bytes.toString('utf8')]));break;
      case 'origin-comment-tags':value=scanSourceClauseTags(request.source,{sourcePath:request.path});break;
      default:throw new SingularityFlowError('Unknown carried-tag observation.',{code:'ENGINE_PORT_UNAVAILABLE'});
    }
  }
}

/** Native work-interval binding and Git/file facts; line ownership is a shared value rule. */
async function storyAddedTagLines(root,workflow,occurrences,tag,pathContext) {
  const baseline=workflow.workIntervals?.history?.[0]?.sourceBaseCommit??workflow.workIntervals?.current?.sourceBaseCommit,
    replay=storyTagLinesReplay({baseline,occurrences,tag,pathContext});let value;
  for(;;) {
    const step=replay.next(value);if(step.done)return step.value;const request=step.value;
    switch(request.kind) {
      case 'origin-line-deltas':value=gitTagLineDeltas(worktreePatchMatching(root,request.baseline,request.tag==='clause'?'@[Cc][Ll][Aa][Uu][Ss][Ee]':'@[Aa][Cc]'));break;
      case 'origin-tracked-paths':value=new Set(trackedPaths(root,request.paths));break;
      case 'origin-untracked-text':value=await readFile(path.join(root,...request.path.split('/')),'utf8');break;
      default:throw new SingularityFlowError('Unknown Story tag observation.',{code:'ENGINE_PORT_UNAVAILABLE'});
    }
  }
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
export async function discoverAcceptanceWitnesses(root,phase,input={}) {
  const replay=discoverAcceptanceWitnessesReplay(phase,input);let step=replay.next();
  while(!step.done){let value;try{const request=step.value;switch(request.kind){
    case 'witness-test-commands':value=await resolveDeliveryQualityCommands(root,request.phase,{executionMode:request.executionMode}).catch(()=>[]);break;
    case 'witness-command-for-file':value=await (await import('./test-module-markers.mjs')).commandForTestFile(root,request.commands,request.file);break;
    case 'witness-declarations':value=await discoverDeclarations(root,request.profile,request.files);break;
    default:throw new SingularityFlowError('Unknown witness discovery observation.',{code:'ENGINE_PORT_UNAVAILABLE'});
  }}catch(error){step=replay.throw(error);continue;}step=replay.next(value);}
  return step.value;
}

/**
 * Bind each source-bound planned clause to an explicit comment in one of its exact planned
 * product-source paths. The reviewed plan pointer, rather than an arbitrary claims file in the
 * directory, is authority. Test-only and reviewed not-applicable rows have no source-tag duty.
 */

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

export async function plannedSourceClauseBindings(root,config,workflow,phase,sourcePaths,options={}) {
  const replay=plannedSourceClauseBindingsReplay(config,workflow,phase,sourcePaths,options),secured=new Map();let value;
  const directory=()=>path.join(root,config.workItemRoot??'singularity/work-items',workflow.workItem.id);
  for(;;) {
    const step=replay.next(value);if(step.done)return step.value;const request=step.value;
    switch(request.kind) {
      case 'source-binding-records':value=await loadActiveSpecRecords(directory(),workflow);break;
      case 'source-binding-plan':value=await readBoundSpecificationClaimMap(root,directory(),workflow,request.owner,'planned',{clauseIds:request.clauseIds,policy:request.policy});break;
      case 'source-binding-path':{
        const found=await secureRepositoryPath(root,request.path,{label:'Planned product source'});secured.set(request.path,found);
        value={exists:found.exists,regular:Boolean(found.entry?.isFile()),size:found.entry?.size??0};break;
      }
      case 'source-binding-bytes':value=await readFile(secured.get(request.path).absolute);break;
      case 'source-binding-tags':value=scanSourceClauseTags(request.source,{sourcePath:request.path});break;
      case 'carried-source-tags':value=carriedTags(root,request.changeSet,request.occurrences,'clause');break;
      case 'story-added-source-tags':value=await storyAddedTagLines(root,workflow,request.occurrences,'clause',request.pathContext);break;
      case 'source-binding-unchanged-tags':value=await unchangedClauseTags(root,request.entry,new Set(request.available));break;
      default:throw new SingularityFlowError('Unknown source-clause evidence request.',{code:'ENGINE_PORT_UNAVAILABLE'});
    }
  }
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

function formatCodeDeliveryPreflightRefusal(request, workflow, phase) {
    switch (request.reason) {
        case 'protected': {
            const { protectedPaths } = request;
            return new SingularityFlowError(`Generation cannot modify protected process paths: ${protectedPaths.join(', ')}`, {
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
            });
        }
        case 'unsafe': {
            const { unsafeExclusions } = request;
            return new SingularityFlowError(`Phase ${phase.id} has changed files another step's plan names, and tests would run with them while this generation left them out: ${unsafeExclusions.join(', ')}. `
                + 'Publish them with the step that owns them, account for them here with singularity-flow decision plan, or move them out of the worktree, then publish again.', {
                code: 'GENERATION_EXCLUSIONS_UNSAFE',
                details: {
                    phase: phase.id, paths: unsafeExclusions,
                    recoveryCommands: unsafeExclusions.slice(0, 3).map((candidate) => `singularity-flow decision plan ${workflow.workItem.id} --add-location <clause>=${candidate} --reason <why>`)
                }
            });
        }
        case 'unreconciled': {
            const { unresolved } = request;
            return new SingularityFlowError(`These changed files would be excluded from ${phase.id}: ${unresolved.join(', ')}. Account for Story edits under an approved clause with a narrow plan amendment, or preserve unrelated edits through recovery's confirmed private-copy route. Resolve them here before publication; do not reset Planning or commit them manually.`, {
                code: 'GENERATION_EXCLUDED_CHANGES_UNRESOLVED', details: {
                    workId: workflow.workItem.id, phase: phase.id, paths: unresolved, excludedChanges: unresolved,
                    priorApprovalsPreserved: true, repairScope: 'current-phase',
                    accountingCommand: `singularity-flow decision plan ${workflow.workItem.id} --add-location ${renderPlatformCommand([`<CLAUSE>=${unresolved[0]}`], 'darwin')} --reason <why>`,
                    recoveryCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`
                }
            });
        }
        case 'evidence': {
            const { errors, unknownCriteria, criteria, requiredAcIds, unchangedGeneration, testOnlyChange, implementationMissing, sourceBindings, bound, cornerCaseGate, findings, candidateSha256, fulfillment, sourcePaths, testPaths, missingAcIds, obligations, witnessDiscovery } = request;
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
            return new SingularityFlowError(`Phase ${phase.id} has no publishable code delivery:\n- ${errors.join('\n- ')}\n`
                + (deliveryRoute ? deliveryRoute.guidance
                    : !unknown ? 'Implement the approved behavior, add acceptance-mapped tests, and publish again.'
                        : `${correction}${errors.length > 1 ? ' Resolve the other findings too, then publish again.' : ' Then publish again.'}`), {
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
            });
        }
        default: throw new SingularityFlowError('Unknown code-delivery refusal context.', { code: 'ENGINE_PORT_REQUEST_INVALID' });
    }
}

/** Refuse a code phase before generation state or telemetry is mutated. */
export async function evaluateCodeDeliveryPreflight(root, config, workflow, phase, { strictCoverage = false, ignoreDisputes = false, requireReconciled = false } = {}) {
  const plan=codeDeliveryPreflightReplay(config,workflow,phase,{strictCoverage,ignoreDisputes,requireReconciled});
  const workingPaths=new Map(),itemDirectory=()=>path.join(root,config.workItemRoot??'singularity/work-items',workflow.workItem.id);
  const read=async request=>{
    switch(request.kind){
      case 'prepare-local-exclusions':return excludeAlwaysLocalNames(root);
      case 'verify-work-interval':return verifyWorkIntervalBaseline(root,config,workflow,{phaseId:phase.id,itemDirectory:itemDirectory()});
      case 'working-change-set':{const {kind,...input}=request;return buildRepositoryChangeSet(root,input);}
      case 'merged-base-paths':return storyMergedBaseChanges(root,config,workflow,request.paths);
      case 'candidate-scope':return codeCandidateScope(itemDirectory(),workflow,phase);
      case 'outside-candidates':return outsideEveryCandidate(itemDirectory(),workflow);
      case 'unreconciled-candidates':return unreconciledCandidatePaths(root,config,workflow,phase,request.scope);
      case 'documentation-baseline':return assertPublishedDocumentationBaseline(root,config,workflow,phase,request.priorGenerationCommit);
      case 'executable-test-path':return isExecutableTestSourcePath(root,request.candidate,{sourceExtensions:request.sourceExtensions});
      case 'reusable-paths':return validatedReusablePaths(root,request.candidates,request.priorEvidence,request.options);
      case 'reviewed-baseline-tests':return (await import('./test-recovery-admission.mjs')).qualifiedTrpBaselineTestPaths(root,config,workflow,phase);
      case 'allocated-obligations':return allocatedPlanObligations(root,config,workflow,phase);
      case 'working-path-facts':{
        const secured=await secureRepositoryPath(root,request.candidate,{label:request.label});workingPaths.set(request.candidate,secured);
        return {exists:secured.exists,regular:secured.entry?.isFile()??false,bytes:secured.entry?.size??0};
      }
      case 'working-path-bytes':return readFile(workingPaths.get(request.candidate).absolute);
      case 'required-acceptance':return acceptanceIds(root,config,workflow,phase);
      case 'specification-records':return loadActiveSpecRecords(itemDirectory(),workflow);
      case 'acceptance-tags':return taggedAcceptanceIds(root,request.testPaths);
      case 'story-added-acceptance-tags':return storyAddedTagLines(root,workflow,request.locations.map(location=>({path:location.testSource,line:location.line})),'ac',request.pathContext);
      case 'acceptance-witnesses':{const {kind,...input}=request;return discoverAcceptanceWitnesses(root,phase,input);}
      case 'carried-criterion-tags':return carriedTags(root,request.changeSet,request.occurrences,'ac');
      case 'source-clause-bindings':return plannedSourceClauseBindings(root,config,workflow,phase,request.sourcePaths,{deletedSourcePaths:request.deletedSourcePaths,changeSet:request.changeSet});
      case 'implementation-bindings':return implementationBindings(root,{changeSet:request.changeSet,required:request.required,tags:request.tags});
      case 'corner-case-analysis':{const {kind,...input}=request;return (await import(CORNER_CASE_MODULE)).evaluateDeliveryCornerCaseGate(root,input);}
      case 'compact-corner-cases':return (await import(CORNER_CASE_MODULE)).compactCornerCaseMatrix(request.matrix);
      case 'accepted-dispute':return (await import('./phase-finding-dispute.mjs')).codeDeliveryDisputeStatus(root,config,workflow,phase,{problems:request.problems,findings:request.findings,candidateSha256:request.candidateSha256});
      case 'format-preflight-refusal':return formatCodeDeliveryPreflightRefusal(request,workflow,phase);
      case 'path-evidence':return pathEvidence(root,request.paths,{changeSet:request.changeSet});
      case 'candidate-coverage':{
        const preview=await import('./spec-coverage-preview.mjs');
        return (request.strictCoverage?preview.assertStrictCandidateSpecificationCoverage:preview.assertCandidateSpecificationCoverage)(root,config,workflow,phase,request.delivery);
      }
      default:throw new SingularityFlowError('Unknown code-delivery preflight request.',{code:'ENGINE_PORT_REQUEST_INVALID'});
    }
  };
  let step=plan.next();
  while(!step.done){let facts;try{facts=await read(step.value);}catch(error){step=plan.throw(error);continue;}step=plan.next(facts);}
  return step.value;
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
export {testCommandProvenance} from './kernel/verification-witnesses.mjs';

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
