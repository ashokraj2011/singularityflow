import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import {
  inferModuleTestCommand, isAllowedTestAutomationPath, isExecutableTestSourcePath,
  isSupportingTestResourcePath, readDurableTestObservation, replayLocalJavascriptJsonObservation,
  replayLocalJunitObservation, resolveAffectedModule, testReceiptPassing
} from './code-delivery-tests.mjs';
import {
  buildRepositoryChangeSet, buildRepositoryTreeChangeSet, evaluateSourceBoundary,
  verifyRepositoryChangeSetIntegrity
} from './repository-change-set.mjs';
import {
  autoCandidateResourceDigest, validateAutoCandidateBinding,
  validateAutoCandidateVerification
} from './auto/auto-candidate.mjs';
import { evaluateStoryProtectedPaths } from './configuration-materialization.mjs';
import { exactChangedPathsBetweenObjects, exactFileAtObject, isAncestor } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { normalizeSourceBoundary } from './source-boundary.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { readRecord } from './schema-migrations.mjs';
import {
  verifyExactTestcaseIdentityObservation, welResultAdapter
} from './wel-adapters.mjs';
import { validateWelTestLifecycle } from './wel-test-lifecycle.mjs';
import {
  SOURCE_CHANGING_FULFILLMENT, loadActiveSpecRecords, predecessorSpecClauses, readBoundSpecificationClaimMap
} from './specifications.mjs';
import { normalizeQualifiedClauseId, scanSourceClauseTags } from './traceability-ids.mjs';
import { bindingsDigest, clauseTagExplanation, EXPLANATION_LIMITS, implementationBindings } from './implementation-bindings.mjs';
import { inferRepositoryTestCommands } from './repository-test-command-inference.mjs';
import { SingularityFlowError, posix, run, secureRepositoryPath, snapshot } from './util.mjs';
import {
  applicationChangeSetProjection, applicationPathContext, isApplicationChangeEntry,
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
          : ' Restore the original governed Code submission evidence before requesting a confirmed return; run singularity-flow doctor --json to inspect missing evidence.'),
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
  // A review pinned to one step's tests (testEvidenceFrom) consumes exactly that tested tree.
  if (changedPaths.length && !pinnedTestEvidenceSource(workflow, phase)) {
    const base = await governedReviewBaseline(root, config, workflow, {
      phase, source, evidenceCommit: packet.evidenceCommit, pathContext
    });
    if (base !== packet.evidenceCommit) changedPaths = await unpermittedReviewPaths(root, base, subject, permission);
  }
  if (changedPaths.length) throw refuse(`source or tests changed after their approved execution: ${changedPaths.join(', ')}.`, changedPaths);
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

function pathInside(candidate, root) {
  const value = posix(candidate ?? '');
  const prefix = posix(root ?? '').replace(/\/$/, '');
  return Boolean(value && prefix && (value === prefix || value.startsWith(`${prefix}/`)));
}

// Documentation may accompany a code delivery, but it cannot itself satisfy the product-source
// requirement. Keep this intentionally narrow: a Markdown file under docs/ or a nested README
// may be executable product input in a documentation application. Only conventional top-level
// project notes get this special classification.
function isDocumentationPath(candidate) {
  const relative = posix(candidate ?? '');
  return /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE)(?:\.(?:md|markdown|mdx|rst|adoc|txt))?$/iu.test(relative);
}

/**
 * Describe what each changed path is for without pretending path names prove who authored bytes.
 * Explicit authorship/change-origin declarations live on the generation receipt; this projection
 * only supplies deterministic repository roles and clearly labels its path-policy inference.
 */
export function classifyDeliveryChanges(changeSet, {
  generatedRoots = [], declaredOrigins = [], pathContext = null
} = {}) {
  const roots = [...new Set(generatedRoots.map(posix).filter(Boolean))];
  const entries = (changeSet?.entries ?? [])
    .filter((entry) => isApplicationChangeEntry(entry, pathContext)).map((entry) => {
    const candidate = entry.newPath ?? entry.oldPath;
    const configuredGenerated = roots.some((root) => pathInside(candidate, root));
    const testOutput = /(?:^|\/)(?:\.sflow\/results|coverage|test-results|surefire-reports)(?:\/|$)/i.test(candidate ?? '');
    const compilerOutput = /(?:^|\/)(?:target|build|dist|out)(?:\/(?:classes|generated|resources))?(?:\/|$)/i.test(candidate ?? '');
    const migration = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/i.test(candidate ?? '');
    const test = isAllowedTestAutomationPath(candidate ?? '');
    const tooling = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i.test(candidate ?? '');
    const documentation = isDocumentationPath(candidate);
    const generated = configuredGenerated || isGeneratedOutputPath(candidate ?? '');
    const role = configuredGenerated ? 'generated-source'
      : testOutput ? 'test-output'
        : compilerOutput ? 'compiler-output'
          : migration ? 'migration'
            : test ? 'test-source'
              : tooling ? 'build-configuration'
                : documentation ? 'documentation'
                  : generated ? 'generated-output' : 'product-source';
    const likelyOrigin = configuredGenerated ? 'code-generator'
      : testOutput ? 'test-runner'
        : compilerOutput ? 'compiler'
          : migration ? 'migration-tool-or-human'
            : 'authorship-declared';
    return {
      changeId: entry.changeId, status: entry.status,
      oldPath: entry.oldPath, newPath: entry.newPath,
      role, generated, likelyOrigin, inference: 'path-policy'
    };
  });
  const counts = Object.fromEntries([...new Set(entries.map((entry) => entry.role))]
    .sort().map((role) => [role, entries.filter((entry) => entry.role === role).length]));
  return {
    schemaVersion: 1, inference: 'path-policy', declaredOrigins: [...declaredOrigins],
    generatedRoots: roots, counts, entries
  };
}

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
  if (indexed.length) return [...new Set(indexed)].sort();
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

export async function taggedAcceptanceIds(root, testPaths, requiredIds = [], {
  requireNamespaceQualifiedIds = false, requireCommentTags = false
} = {}) {
  const exact = new Set();
  const bare = new Set();
  const exactSources = new Map();
  const bareSources = new Map();
  for (const relative of testPaths) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Acceptance test source', type: 'file'
    });
    if (!secured.exists) continue;
    const text = await readFile(secured.absolute, 'utf8');
    const values = requireCommentTags
      ? scanSourceClauseTags(text, { legacy: true })
        .filter((item) => item.tag === 'ac').map((item) => item.clauseId)
      : [...text.matchAll(/@ac:\s*((?:[A-Z0-9][A-Z0-9._-]{0,63}:)?AC-\d+)/gi)]
        .map((match) => match[1].toUpperCase());
    for (const value of values) {
      const target = value.includes(':') ? exact : bare;
      const sources = value.includes(':') ? exactSources : bareSources;
      target.add(value);
      if (!sources.has(value)) sources.set(value, new Set());
      sources.get(value).add(relative);
    }
  }
  const ambiguous = [];
  const inferred = [];
  const bindings = [];
  for (const clauseId of exact) {
    const suffix = clauseId.slice(clauseId.lastIndexOf(':') + 1);
    const legacyBareMatches = requiredIds.filter((id) => id === suffix);
    const competingQualifiedTags = [...exact].filter((id) => id.endsWith(`:${suffix}`));
    // Some pre-index Stories persist an intrinsically bare AC identity even though their tests
    // already use a namespace-qualified tag. Preserve the stronger test identity and bind it to
    // the one bare durable clause only when there is no competing namespace. This is not suffix
    // guessing: one competing qualified tag makes the binding ambiguous and blocks delivery.
    if (!requiredIds.includes(clauseId) && legacyBareMatches.length === 1) {
      if (competingQualifiedTags.length > 1) {
        ambiguous.push({ suffix, matches: competingQualifiedTags, reason: 'legacy-clause-ambiguous' });
        continue;
      }
      inferred.push(legacyBareMatches[0]);
      for (const testSource of exactSources.get(clauseId) ?? []) {
        bindings.push({
          clauseId: legacyBareMatches[0], testSource,
          bindingAssurance: 'namespace-qualified-legacy-clause', tag: clauseId
        });
      }
      continue;
    }
    for (const testSource of exactSources.get(clauseId) ?? []) {
      bindings.push({ clauseId, testSource, bindingAssurance: 'namespace-qualified' });
    }
  }
  for (const suffix of bare) {
    const matches = requiredIds.filter((id) => id === suffix || id.endsWith(`:${suffix}`));
    const namespacedMatches = matches.filter((id) => id.includes(':'));
    // Installed Stories created before specification indexes may legitimately have only a bare
    // clause identity. Namespace enforcement cannot invent a namespace for those records; it
    // becomes mandatory as soon as the pinned specification supplies one. This keeps the new
    // policy strict for modern records without making legacy, intrinsically bare identities
    // impossible to satisfy.
    if (requireNamespaceQualifiedIds && namespacedMatches.length) {
      ambiguous.push({ suffix, matches, reason: 'namespace-required' });
      continue;
    }
    if (matches.length === 1) {
      inferred.push(matches[0]);
      for (const testSource of bareSources.get(suffix) ?? []) {
        bindings.push({
          clauseId: matches[0], testSource,
          bindingAssurance: requireNamespaceQualifiedIds ? 'namespace-not-applicable' : 'legacy-inferred'
        });
      }
    }
    else if (matches.length > 1) ambiguous.push({ suffix, matches });
    else {
      exact.add(suffix);
      for (const testSource of bareSources.get(suffix) ?? []) {
        bindings.push({ clauseId: suffix, testSource, bindingAssurance: 'legacy-unresolved' });
      }
    }
  }
  return {
    ids: [...new Set([...exact, ...inferred])].sort(), inferred: inferred.sort(), ambiguous,
    bindings: bindings.sort((left, right) => left.clauseId.localeCompare(right.clauseId) || left.testSource.localeCompare(right.testSource))
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
    && (claim.expectedPaths ?? []).length > 0;
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
 * Judge each allocated obligation that is not delivered by new or modified product source by its
 * own fulfillment [E2G-010]: behaviour that already exists must still be at its paths, removed
 * behaviour must be gone, and a document or configuration change must change exactly its paths.
 */
async function fulfillmentEvidence(root, obligations, changedPaths, deletedPaths) {
  const changed = new Set([...changedPaths, ...deletedPaths]);
  const entries = [];
  const problems = [];
  for (const obligation of obligations ?? []) {
    if (!['existing', 'removed', 'document', 'configuration'].includes(obligation.fulfillment)) continue;
    const paths = [];
    for (const candidate of obligation.expectedPaths) {
      const secured = await secureRepositoryPath(root, candidate, { label: `Planned ${obligation.fulfillment} path` });
      const present = Boolean(secured.exists && secured.entry?.isFile());
      if (obligation.fulfillment === 'existing') {
        paths.push({ path: candidate, state: present ? 'present' : 'missing',
          sha256: present ? createHash('sha256').update(await readFile(secured.absolute)).digest('hex') : null });
        if (!present) problems.push(`${obligation.clauseId} is existing behaviour, but ${candidate} does not exist`);
      } else if (obligation.fulfillment === 'removed') {
        paths.push({ path: candidate, state: present ? 'present' : 'absent' });
        if (present) problems.push(`${obligation.clauseId} removes ${candidate}, but it still exists`);
      } else {
        paths.push({ path: candidate, state: changed.has(candidate) ? 'changed' : 'unchanged' });
        if (!changed.has(candidate)) problems.push(`${obligation.clauseId} is a ${obligation.fulfillment} change, but ${candidate} did not change`);
      }
    }
    entries.push({ clauseId: obligation.clauseId, fulfillment: obligation.fulfillment, paths });
  }
  return { obligations: entries, problems };
}

export async function plannedSourceClauseBindings(root, config, workflow, phase, sourcePaths, {
  deletedSourcePaths = []
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
        throw new SingularityFlowError(`Planned source clause '${rawClauseId}' is not a qualified governed ID.`, {
          code: 'CODE_DELIVERY_SOURCE_CLAUSE_ID_INVALID'
        });
      }
      return { clauseId, expectedPaths: [...claim.expectedPaths].sort() };
    })
    .sort((left, right) => left.clauseId.localeCompare(right.clauseId));
  const candidates = [...new Set(required.flatMap((entry) => entry.expectedPaths))]
    .filter((candidate) => available.has(candidate) && !isAllowedTestAutomationPath(candidate))
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
    tagsByPath.set(relative, scanSourceClauseTags(sourceBytes.toString('utf8'))
      .filter((tag) => tag.tag === 'clause' && normalizeQualifiedClauseId(tag.clauseId)));
  }
  const bindings = required.flatMap(({ clauseId, expectedPaths }) => expectedPaths.flatMap((sourcePath) =>
    (tagsByPath.get(sourcePath) ?? [])
      .filter((tag) => tag.clauseId === clauseId)
      .map(({ line, tag }) => ({ clauseId, sourcePath, line, tag }))));
  const deleted = new Set(deletedSourcePaths);
  for (const { clauseId, expectedPaths } of required) {
    for (const sourcePath of expectedPaths) {
      if (deleted.has(sourcePath) && available.has(sourcePath) && !tagsByPath.has(sourcePath)) {
        bindings.push({ clauseId, sourcePath, line: null, tag: 'deletion' });
      }
    }
  }
  const missing = required.filter(({ clauseId }) =>
    !bindings.some((binding) => binding.clauseId === clauseId));
  return { mode: 'enforce', required, bindings, missing };
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
      kind: isAllowedTestAutomationPath(relative) ? 'test'
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
        `Previously governed ${role} path '${record.path}' is missing, replaced, symbolic, no longer executable, or differs from its prior evidence. Change or restore it in the current generation.`,
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
export async function evaluateCodeDeliveryPreflight(root, config, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase)) return null;
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
  if (!protectedResult.valid) {
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
  const applicationEntries = changeSet.entries
    .filter((entry) => isApplicationChangeEntry(entry, pathContext));
  const applicationChangeSet = { ...changeSet, entries: applicationEntries };
  const boundaryResult = evaluateSourceBoundary(applicationChangeSet, phase.sourceBoundary, {
    phaseId: phase.id, allowedPath: isAllowedTestAutomationPath
  });
  if (!boundaryResult.valid) {
    throw new SingularityFlowError(
      `Phase ${phase.id} may change test automation only; product-source endpoints are outside its governed boundary: ${boundaryResult.violations.map((entry) => entry.path).join(', ')}`,
      { code: 'CHANGE_SET_POLICY_VIOLATION' }
    );
  }
  const currentPaths = applicationEntries
    .filter((entry) => entry.status !== 'deleted' && entry.newPath
      && (entry.newContent?.kind === 'regular-file' || entry.newMode === '160000'))
    .map((entry) => entry.newPath);
  const changedPaths = [...new Set(currentPaths)].sort();
  const changedEndpointPaths = new Set(applicationEntries.flatMap((entry) =>
    [entry.oldPath, entry.newPath].filter(Boolean)));
  const changedTestCandidates = changedPaths.filter(isAllowedTestAutomationPath);
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
  const deletedSourcePaths = applicationEntries
    .filter((entry) => entry.oldPath && entry.oldPath !== entry.newPath
      && !isAllowedTestAutomationPath(entry.oldPath) && !isDocumentationPath(entry.oldPath))
    .map((entry) => entry.oldPath);
  const changedSourcePaths = [...new Set([
    ...changedPaths.filter((candidate) => !isAllowedTestAutomationPath(candidate)
      && !isDocumentationPath(candidate)),
    ...deletedSourcePaths
  ])].sort();
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
  const testOnlyRepair = !changedSourcePaths.length && Boolean(repair)
    && Boolean(repairDecision)
    && Number(phase.generation ?? 0) > 0
    && Number(repair.codeGeneration) === Number(phase.generation)
    && repair.codeGenerationCommit === phase.generationCommit
    && String(repair.codeReceiptSha256).replace(/^sha256:/u, '')
      === String(phase.deliveryEvidence?.receiptSha256 ?? '').replace(/^sha256:/u, '')
    && /^sha256:[a-f0-9]{64}$/u.test(repair.confirmation ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(repair.changeSetDigest ?? '')
    && Array.isArray(repair.changedPaths) && repair.changedPaths.length > 0
    && applicationEntries.length > 0
    && applicationEntries.every((entry) => [entry.oldPath, entry.newPath]
      .filter(Boolean).every(isAllowedTestAutomationPath));
  const reusableSourceCandidates = intentRevalidation || testOnlyRepair || documentationOnlyCorrection
    ? (phase.deliveryEvidence?.sourcePaths ?? []).filter((candidate) =>
      !changedEndpointPaths.has(candidate) && !isDocumentationPath(candidate))
    : [];
  const reusableSourcePaths = await validatedReusablePaths(
    root, reusableSourceCandidates, phase.deliveryEvidence?.paths, { role: 'source' }
  );
  const sourcePaths = [...new Set([...changedSourcePaths, ...reusableSourcePaths])].sort();
  const errors = [];
  // What this step owes comes from its allocated obligations [E2G-010]: existing behaviour changes
  // nothing, and test-only, document, configuration and removal work need no new product source.
  const fulfillment = await fulfillmentEvidence(root, obligations, changedPaths, deletedSourcePaths);
  const changeRequired = !obligations || obligations.some((obligation) => obligation.fulfillment !== 'existing');
  const sourceRequired = !obligations || obligations.some(changesProductSource);

  if (!applicationEntries.length && !intentRevalidation && changeRequired) {
    errors.push('no application source or test paths changed during the governed work interval');
  }
  if (phase.sourceBoundary !== 'test-automation' && !sourcePaths.length && sourceRequired) {
    errors.push('no product source path changed; a summary or test-only edit is not an implementation');
  }
  errors.push(...fulfillment.problems);
  if (!testPaths.length) errors.push('no acceptance test is available for the implementation');

  const requiredAcIds = await acceptanceIds(root, config, workflow, phase);
  const tags = await taggedAcceptanceIds(root, testPaths, requiredAcIds, {
    requireNamespaceQualifiedIds: workflow.resolution?.codeDelivery?.traceability?.requireNamespaceQualifiedIds === true,
    requireCommentTags: workflow.resolution?.codeDelivery?.traceability?.sourceBindings === 'enforce'
  });
  if (tags.ambiguous.length) {
    const namespaceRequired = tags.ambiguous.some((item) => item.reason === 'namespace-required');
    throw new SingularityFlowError(
      namespaceRequired
        ? `Acceptance tags must be namespace-qualified: ${tags.ambiguous.map((item) => item.suffix).join(', ')}`
        : `Bare acceptance tag is ambiguous: ${tags.ambiguous.map((item) => `${item.suffix} -> ${item.matches.join(', ')}`).join('; ')}`,
      { code: namespaceRequired ? 'AC_NAMESPACE_REQUIRED' : 'AC_NAMESPACE_AMBIGUOUS' }
    );
  }
  const taggedAcIds = tags.ids;
  const missingAcIds = requiredAcIds.filter((id) => !taggedAcIds.includes(id));
  if (missingAcIds.length) {
    errors.push(`changed tests do not contain required traceability tags: ${missingAcIds.map((id) => `@ac:${id}`).join(', ')}`);
  }
  const sourceBindings = await plannedSourceClauseBindings(root, config, workflow, phase, sourcePaths, {
    deletedSourcePaths
  });
  // Each obligation delivered in source is bound to its changed hunks and its explanation [E2G-011].
  const bound = sourceBindings.mode === 'enforce' && sourceBindings.required.length
    ? await implementationBindings(root, { changeSet, required: sourceBindings.required, tags: sourceBindings.bindings })
    : null;
  if (bound) errors.push(...bound.problems);
  if (sourceBindings.missing.length) {
    errors.push(`planned product source does not contain required clause comments: ${sourceBindings.missing
      .map(({ clauseId, expectedPaths }) => `@clause:${clauseId} in ${expectedPaths.join(' or ')}`).join('; ')}`);
  }
  if (errors.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} has no publishable code delivery:\n- ${errors.join('\n- ')}\n`
      + 'Implement the approved behavior, add acceptance-mapped tests, and publish again.',
      {
        code: 'CODE_DELIVERY_EVIDENCE_REQUIRED',
        details: { sourceBindingsMissing: sourceBindings.missing, explanationsMissing: bound?.explanationsMissing ?? [] }
      }
    );
  }

  return {
    requirement: 'source-and-tests',
    baselineCommit,
    generationIntentId: phase.generationIntent?.id ?? null,
    changeSet,
    changeClassification: classifyDeliveryChanges(changeSet, {
      generatedRoots: workflow.resolution?.ast?.generatedRoots ?? config.ast?.generatedRoots ?? [],
      pathContext
    }),
    paths: await pathEvidence(root, [...new Set([
      ...changedPaths, ...deletedSourcePaths, ...reusableSourcePaths, ...reusableTestPaths, ...baselineTestPaths, ...existingTestPaths
    ])].sort(), { changeSet }),
    sourcePaths,
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
    testingRepair: testOnlyRepair ? {
      changeRequestId: repairRequest.id,
      priorGeneration: repair.codeGeneration,
      priorReceiptSha256: repair.codeReceiptSha256,
      reusedSourcePaths: reusableSourcePaths
    } : null,
    acceptanceCriteria: {
      required: requiredAcIds, tagged: taggedAcIds, missing: [], ambiguous: [],
      inferred: tags.inferred, bindings: tags.bindings
    },
    sourceBindings,
    fulfillment: fulfillment.obligations,
    implementationBindings: bound ? { bindings: bound.bindings, bindingsSha256: bound.bindingsSha256 } : null
  };
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

export async function resolveDeliveryQualityCommands(root, phase) {
  const configured = [...(phase.qualityCommands ?? [])];
  if (!phaseRequiresCodeDelivery(phase)) return configured;
  const configuredTests = configured.filter((command) =>
    command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test');
  const moduleCoveredByConfiguredTest = (moduleRoot) => configuredTests.some((command) =>
    (command.affectedRoots ?? []).some((candidate) => {
      const root = posix(candidate ?? '').replace(/^\.\//, '') || '.';
      return root === '.' || moduleRoot === root || moduleRoot.startsWith(`${root}/`);
    }));
  const inferred = [];
  const deliveryPaths = [...new Set([
    ...(phase.deliveryEvidence?.sourcePaths ?? []),
    ...(phase.deliveryEvidence?.testPaths ?? [])
  ])];
  const modules = new Map();
  for (const candidate of deliveryPaths) {
    const module = await resolveAffectedModule(root, candidate).catch((error) => {
      if (error?.code === 'TEST_MODULE_UNCOVERED') return null;
      throw error;
    });
    if (module) modules.set(`${module.root}:${module.system}`, module);
  }
  for (const module of modules.values()) {
    if (moduleCoveredByConfiguredTest(module.root)) continue;
    const command = await inferModuleTestCommand(root, module);
    if (command) inferred.push(command);
    if (module.system === 'node' && command?.result?.adapter !== 'playwright-json') {
      // A Node unit script is not evidence that newly authored browser tests ran. Add one
      // unambiguous direct Playwright script when the module declares it separately.
      for (const nodeScript of ['test:e2e', 'test:playwright', 'e2e']) {
        const browserCommand = await inferModuleTestCommand(root, module, { nodeScript });
        if (browserCommand?.result?.adapter === 'playwright-json') {
          inferred.push(browserCommand);
          break;
        }
      }
    }
  }
  // A recognized changed module with no supported runner must not borrow an unrelated root
  // manifest's passing tests as its own execution evidence.
  if (!inferred.length && !configuredTests.length && !modules.size) {
    inferred.push(...await inferRepositoryTestCommands(root));
  }
  if (!inferred.length && !configuredTests.length) {
    const tests = phase.deliveryEvidence?.testPaths ?? [];
    if (tests.length && tests.every((candidate) => /\.(?:c|m)?js$/i.test(candidate))) {
      inferred.push({
        id: 'node-tests', kind: 'test',
        argv: ['node', '--test', '--test-reporter=junit', ...tests],
        workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: '.sflow/results/node-tests.xml', minimumDiscovered: 1 }
      });
    }
  }
  const seen = new Set(configured.map(commandText));
  return [...configured, ...inferred.filter((command) => command && !seen.has(commandText(command)))];
}

function receiptDigest(record) {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

function pathCoveredByRoots(candidate, roots = []) {
  return roots.some((root) => root === '.' || candidate === root
    || candidate.startsWith(`${root.replace(/\/$/, '')}/`));
}

function safeEvidencePath(value) {
  const candidate = String(value ?? '');
  return candidate && !path.posix.isAbsolute(candidate) && !candidate.includes('\\')
    && !candidate.includes(':') && !candidate.includes('\0')
    && !candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

const MODEL_ASSURANCE_RANK = Object.freeze({
  unavailable: 0, 'host-observed': 1, 'provider-reported': 2, 'policy-selected': 3
});
function modelAssuranceRank(value) {
  return MODEL_ASSURANCE_RANK[value === 'observed' ? 'host-observed' : value] ?? -1;
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
  evidenceCommit = null,
  pathContext = null,
  testRecovery = null
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!receipt || receipt.kind !== 'code-delivery' || Number(receipt.schemaVersion) !== 2) {
    return { valid: false, errors: ['code-delivery v2 receipt is unavailable'] };
  }
  if (receipt.status !== 'ready') fail(`code-delivery receipt is ${receipt.status ?? 'unavailable'}`);

  const generationCommit = receipt.tree?.generationCommit;
  if (!generationCommit) fail('generation commit is absent');
  else {
    const tree = run('git', ['rev-parse', '--verify', `${generationCommit}^{tree}`], { cwd: root, allowFailure: true });
    if (tree.status !== 0) fail(`generation commit ${generationCommit} is unavailable`);
    else if (tree.stdout.trim() !== receipt.tree?.generationTree) fail('generation tree differs from the committed generation');
  }

  let changeSet = null;
  if (!generationCommit || !receipt.changeSet?.path) fail('committed repository change set is absent');
  else {
    const historical = run('git', ['show', `${generationCommit}:${receipt.changeSet.path}`], { cwd: root, allowFailure: true });
    if (historical.status !== 0) fail('repository change set was not committed with the generation');
    else {
      try { changeSet = readRecord('repository-change-set', historical.stdout).record; }
      catch (error) { fail(`repository change set is unreadable: ${error.message}`); }
    }
  }
  if (changeSet) {
    const integrity = verifyRepositoryChangeSetIntegrity(changeSet);
    if (!integrity.valid) fail('repository change-set integrity does not reproduce');
    if (changeSet.digest !== receipt.changeSet.digest) fail('repository change-set digest differs from its receipt');
    const protectedResult = evaluateStoryProtectedPaths(changeSet, protectedPaths, configurationSource);
    if (!protectedResult.valid) fail(`protected path policy fails: ${protectedResult.violations.map((item) => item.path).join(', ')}`);
    const applicationChangeSet = {
      ...changeSet,
      entries: changeSet.entries.filter((entry) => isApplicationChangeEntry(entry, pathContext))
    };
    const boundary = evaluateSourceBoundary(applicationChangeSet, sourceBoundary, {
      phaseId: receipt.phase, allowedPath: isAllowedTestAutomationPath
    });
    if (!boundary.valid) fail(`source boundary fails: ${boundary.violations.map((item) => item.path).join(', ')}`);
    if (symlinkPolicy === 'reject' && applicationChangeSet.entries.some((entry) => entry.newContent?.kind === 'symlink')) {
      fail('source or test delivery contains a symbolic link');
    }
    if (receipt.autoCandidate) {
      try {
        const candidate = validateAutoCandidateBinding(receipt.autoCandidate);
        const verification = validateAutoCandidateVerification(
          receipt.autoCandidateVerification
        );
        if (verification.status !== 'passed'
            || verification.flightId !== candidate.flightId
            || verification.candidateId !== candidate.candidateId
            || verification.candidateSha256 !== candidate.candidateSha256
            || verification.bindingSha256 !== candidate.bindingSha256) {
          fail('Auto Candidate verification does not bind the published Candidate');
        }
        if (candidate.candidateSha256 !== receipt.tree?.workingStateDigest) {
          fail('Auto Candidate source-tree identity differs from the published generation');
        }
        if (receipt.tree?.generationTree) {
          const publishedCandidate = applicationChangeSetProjection(buildRepositoryTreeChangeSet(root, {
            baseTree: candidate.repository.baselineTree,
            targetTree: receipt.tree.generationTree,
            subject: { kind: 'auto-candidate', id: candidate.attemptId }
          }), pathContext);
          const publishedResourceDigest = autoCandidateResourceDigest(publishedCandidate, {
            baselineTree: candidate.repository.baselineTree,
            candidateSha256: candidate.candidateSha256
          });
          if (publishedResourceDigest !== candidate.applicationResourceDigest) {
            fail('Auto Candidate resource delta differs from the published generation tree');
          }
        }
      } catch (error) {
        fail(`Auto Candidate binding is invalid: ${error.message}`);
      }
    }
  }

  // The bindings a reviewer approves are exactly the recorded ones, and every explanation is still
  // on its tag line in the committed generation [E2G-011].
  if (receipt.implementationBindings) {
    const { bindings, bindingsSha256 } = receipt.implementationBindings;
    if (!Array.isArray(bindings) || bindingsDigest(bindings) !== bindingsSha256) fail('implementation bindings do not match their digest');
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      if (!normalizeQualifiedClauseId(binding?.clauseId) || !Array.isArray(binding.regions)) { fail('an implementation binding is malformed'); continue; }
      const explanation = binding.explanation;
      if (explanation == null) continue;
      const text = typeof explanation.text === 'string' ? explanation.text : '';
      const bytes = generationCommit && safeEvidencePath(explanation.path) ? exactFileAtObject(root, generationCommit, explanation.path) : null;
      const line = bytes?.toString('utf8').split(/\r?\n/u)[Number(explanation.line) - 1];
      if (text.length < EXPLANATION_LIMITS.minimum || !line || !(clauseTagExplanation(line, binding.clauseId) ?? '').startsWith(text)) {
        fail(`the explanation of ${binding.clauseId} is not on its tag line in the generation`);
      }
    }
  }
  // Each fulfillment the delivery recorded is replayed against the committed generation [E2G-010].
  for (const obligation of receipt.fulfillment?.obligations ?? []) {
    for (const entry of obligation?.paths ?? []) {
      if (!safeEvidencePath(entry?.path)) { fail(`fulfillment evidence for ${obligation?.clauseId ?? 'unknown'} names an unsafe path`); continue; }
      if (!generationCommit) continue;
      const bytes = exactFileAtObject(root, generationCommit, entry.path);
      if (obligation.fulfillment === 'existing') {
        if (entry.state !== 'present' || !bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
          fail(`existing behaviour of ${obligation.clauseId} is not at ${entry.path} in the generation`);
        }
      } else if (obligation.fulfillment === 'removed') {
        if (entry.state !== 'absent' || bytes) fail(`${entry.path}, removed for ${obligation.clauseId}, is still in the generation`);
      } else if (['document', 'configuration'].includes(obligation.fulfillment)) {
        const changedInSet = (changeSet?.entries ?? []).some((change) => change.newPath === entry.path || change.oldPath === entry.path);
        if (entry.state !== 'changed' || (changeSet && !changedInSet)) {
          fail(`the ${obligation.fulfillment} change of ${obligation.clauseId} did not change ${entry.path}`);
        }
      } else {
        fail(`fulfillment evidence for ${obligation?.clauseId ?? 'unknown'} names an unknown type`);
      }
    }
  }

  const traceability = receipt.traceability ?? {};
  if (traceability.missing?.length) fail(`acceptance bindings are missing: ${traceability.missing.join(', ')}`);
  if (traceability.ambiguous?.length) fail('acceptance bindings are ambiguous');
  const bound = new Set(traceability.bound ?? []);
  const bindings = traceability.bindings ?? [];
  for (const clauseId of traceability.required ?? []) {
    if (!bound.has(clauseId) || !bindings.some((binding) => binding.clauseId === clauseId)) {
      fail(`acceptance clause ${clauseId} has no module test-source binding`);
    }
  }
  if (sourceBindingPolicy === 'enforce') {
    const required = traceability.sourceRequired;
    const sourceBindings = traceability.sourceBindings;
    if (!Array.isArray(required) || !Array.isArray(sourceBindings)) {
      fail('planned source-clause bindings are absent from the code-delivery receipt');
    } else {
      const delivered = new Set(receipt.changeSet?.sourcePaths ?? []);
      for (const item of required) {
        if (!normalizeQualifiedClauseId(item?.clauseId)
            || !Array.isArray(item.expectedPaths) || !item.expectedPaths.length
            || item.expectedPaths.some((candidate) => !safeEvidencePath(candidate))) {
          fail('planned source-clause requirement is invalid');
          continue;
        }
        const witnesses = sourceBindings.filter((binding) => binding?.clauseId === item.clauseId
          && item.expectedPaths.includes(binding.sourcePath));
        if (!witnesses.length) fail(`planned clause ${item.clauseId} has no exact source-comment binding`);
      }
      for (const binding of sourceBindings) {
        const sourcePath = binding?.sourcePath;
        const clauseId = binding?.clauseId;
        const requirement = required.find((item) => item.clauseId === clauseId);
        if (!requirement || !normalizeQualifiedClauseId(clauseId)
            || !safeEvidencePath(sourcePath) || !delivered.has(sourcePath)
            || !requirement.expectedPaths.includes(sourcePath)
            || !['clause', 'deletion'].includes(binding.tag)
            || (binding.tag === 'clause' && (!Number.isInteger(binding.line) || binding.line < 1))
            || (binding.tag === 'deletion' && (binding.line !== null
              || !(receipt.changeSet?.deletedSourcePaths ?? []).includes(sourcePath)))) {
          fail(`source-clause binding for ${clauseId ?? 'unknown'} is outside the reviewed delivery`);
          continue;
        }
        let historical;
        try {
          historical = generationCommit
            ? exactFileAtObject(root, generationCommit, sourcePath, { maximumBytes: MAX_BOUND_SOURCE_BYTES })
            : null;
        } catch (error) {
          fail(`source-clause binding ${clauseId} at ${sourcePath} could not be read: ${error.message}`);
          continue;
        }
        if (binding.tag === 'deletion') {
          if (historical) {
            fail(`planned deletion ${sourcePath} for ${clauseId} still exists in the generation commit`);
          }
        } else if (!historical
            || !scanSourceClauseTags(historical.toString('utf8')).some((tag) =>
              tag.clauseId === clauseId && tag.line === binding.line && tag.tag === 'clause')) {
          fail(`source-clause binding ${clauseId} at ${sourcePath}:${binding.line} does not replay from the generation commit`);
        }
      }
    }
  }

  const executions = new Map();
  for (const execution of receipt.testExecutions ?? []) {
    if (execution.kind === 'phase-validation-observation') {
      try {
        if (!testRecovery?.config || !testRecovery?.workflow || !evidenceCommit || !receipt.testRecovery
          || !['unavailable', 'failed', 'passed'].includes(execution.status) || receipt.testRecovery.observedOutcome !== execution.status
          || receipt.testRecovery.disposition !== 'accepted-risk') throw new Error('authenticated TRP runtime context is required');
        const { assertStoryTestRiskGate } = await import('./test-recovery-runtime.mjs');
        const context = await assertStoryTestRiskGate(root, testRecovery.config, testRecovery.workflow, {
          phaseId: receipt.phase, generation: Number(receipt.generation), operation: testRecovery.operation ?? 'replay',
          observationSha256: receipt.testRecovery.observationSha256, evidenceCommit,
          ...(testRecovery.mode === 'historical' ? { mode: 'historical', at: testRecovery.at } : {}) });
        const observation = context.observations[0];
        if (!observation || context.evaluation.gateDecision !== 'allow-with-risk'
          || (observation.observedOutcome === 'passed' && observation.counts.skipped <= 0)
          || observation.obligationId !== execution.commandId || observation.observedOutcome !== execution.status
          || observation.sourceManifestSha256 !== receipt.tree.workingStateDigest
          || execution.receiptPath !== `${testRecovery.config.workItemRoot ?? 'singularity/work-items'}/${receipt.workId}/context/test-recovery/runs/${observation.id}.json`
          || receiptDigest(observation) !== String(execution.receiptSha256).replace(/^sha256:/u, '')) {
          throw new Error('the risk observation is not bound to this exact committed delivery');
        }
        const phase = testRecovery.workflow.phases?.[receipt.phase];
        const commands = await resolveDeliveryQualityCommands(root, phase);
        const command = commands.find(item => item?.kind === 'test' && item.id === execution.commandId);
        if (!command || canonicalJson(command.affectedRoots) !== canonicalJson(execution.affectedRoots)) {
          throw new Error('risk observation command coverage differs from the approved command contract');
        }
        executions.set(execution.commandId, { commandId: execution.commandId, status: observation.observedOutcome,
          affectedRoots: execution.affectedRoots, observedOutcome: observation.observedOutcome, disposition: 'accepted-risk',
          decisionRefs: context.evaluation.decisionRefs });
      } catch (error) { fail(`TRP risk validation ${execution.commandId} does not replay: ${error.message}`); }
      continue;
    }
    let testReceipt;
    try {
      const source = evidenceCommit
        ? run('git', ['show', `${evidenceCommit}:${execution.receiptPath}`], {
          cwd: root, allowFailure: true, encoding: 'buffer'
        })
        : null;
      if (source && source.status !== 0) throw new Error(`not present in evidence commit ${evidenceCommit}`);
      const storedBytes = source
        ? source.stdout
        : await readDurableTestObservation(root, execution.receiptPath);
      const storedRecord = JSON.parse(Buffer.isBuffer(storedBytes) ? storedBytes.toString('utf8') : storedBytes);
      // The binding was created over the version that was actually stored. Verify those raw
      // canonical bytes before applying an additive schema migration; hashing the migrated shape
      // would make every valid historical v1 receipt appear tampered after v2 ships.
      if (receiptDigest(storedRecord) !== String(execution.receiptSha256 ?? '').replace(/^sha256:/, '')) {
        fail(`test receipt ${execution.commandId} differs from its bound digest`);
      }
      testReceipt = readRecord('test-execution', storedRecord).record;
    }
    catch (error) {
      fail(`test receipt ${execution.commandId} is unavailable: ${error.message}`);
      continue;
    }
    const observation = testReceipt.testcaseObservation;
    if (!validateWelTestLifecycle(testReceipt.lifecycle)) {
      fail(`test receipt ${execution.commandId} has an invalid or authority-inventing WEL lifecycle projection`);
    }
    if (observation?.status === 'observed') {
      if (testReceipt.assurance !== 'module-executed' || testReceipt.testcaseExecutionProven !== false) {
        fail(`test receipt ${execution.commandId} does not preserve module execution as its sole authority`);
      }
      if (observation.assurance !== 'testcase-local-observed') {
        fail(`test receipt ${execution.commandId} overstates its local observation assurance`);
      }
      if (![true, false].includes(observation.exact) || observation.verdict !== 'inconclusive') {
        fail(`test receipt ${execution.commandId} presents a local observation with an invalid exactness or verdict`);
      }
      if (testReceipt.candidate != null || testReceipt.program != null || testReceipt.attempt != null) {
        fail(`test receipt ${execution.commandId} invents unavailable Candidate, Program, or attempt authority`);
      }
      const requiredBindingGaps = [
        'sgos-candidate-unavailable',
        'gvm-program-unavailable',
        'durable-attempt-id-and-nonce-unavailable',
        ...(observation.exact === true ? [] : ['exact-static-test-identity-unavailable']),
        'reviewed-witness-mapping-unavailable'
      ];
      if (!requiredBindingGaps.every((gap) => observation.bindingGaps?.includes(gap))) {
        fail(`test receipt ${execution.commandId} does not disclose its unavailable exact bindings`);
      }
      if (testReceipt.adapter !== welResultAdapter(observation.profile)
          || testReceipt.adapterIdentity?.id !== observation.profile) {
        fail(`test receipt ${execution.commandId} local testcase profile binding is inconsistent`);
      }
      const localExecution = testReceipt.localExecution;
      const startedAt = Date.parse(localExecution?.startedAt ?? '');
      const completedAt = Date.parse(localExecution?.completedAt ?? '');
      const observedCommit = localExecution?.sourceCommit;
      const observedCommitExists = observedCommit
        ? run('git', ['rev-parse', '--verify', `${observedCommit}^{commit}`], {
          cwd: root, allowFailure: true
        }).status === 0
        : false;
      const followsGeneration = observedCommitExists && generationCommit
        ? run('git', ['merge-base', '--is-ancestor', generationCommit, observedCommit], {
          cwd: root, allowFailure: true
        }).status === 0
        : false;
      if (!followsGeneration
          || localExecution?.sourceTreeSha256 !== receipt.tree?.workingStateDigest
          || !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
        fail(`test receipt ${execution.commandId} local execution context is not bound to the retained generation`);
      }
      let exactReplay = null;
      if (observation.exact === true) {
        exactReplay = await verifyExactTestcaseIdentityObservation(root, observation, {
          evidenceCommit
        });
        for (const error of exactReplay.errors) fail(`test receipt ${execution.commandId} ${error}`);
      } else if ((observation.occurrences ?? []).some((occurrence) => occurrence.exact !== false
          || occurrence.verdict !== 'inconclusive'
          || occurrence.logicalTestId != null
          || occurrence.declarationSha256 != null)) {
        fail(`test receipt ${execution.commandId} overstates a name-only testcase occurrence`);
      }
      if (!observation.rawReports?.length) {
        fail(`test receipt ${execution.commandId} has no durable raw report evidence`);
      }
      const replayReports = [];
      const referencedPaths = new Set();
      let replayable = true;
      for (const report of observation.rawReports ?? []) {
        const expectedExtension = testReceipt.adapter === 'junit-xml' ? '.xml' : '.bin';
        const contentAddressedPath = typeof report.path === 'string'
          && report.path.includes('/context/code-delivery/tests/raw/')
          && report.path.endsWith(`/${report.sha256}${expectedExtension}`);
        if (!safeEvidencePath(report.path) || !contentAddressedPath
            || !/^[0-9a-f]{64}$/.test(report.sha256 ?? '')
            || !Number.isInteger(report.bytes) || report.bytes < 0) {
          fail(`test receipt ${execution.commandId} contains an invalid raw report reference`);
          replayable = false;
          continue;
        }
        if (referencedPaths.has(report.path)) {
          fail(`test receipt ${execution.commandId} repeats a raw report reference`);
          replayable = false;
          continue;
        }
        referencedPaths.add(report.path);
        try {
          let bytes;
          if (evidenceCommit) {
            const raw = run('git', ['show', `${evidenceCommit}:${report.path}`], {
              cwd: root, allowFailure: true, encoding: 'buffer'
            });
            if (raw.status !== 0) throw new Error(`not present in evidence commit ${evidenceCommit}`);
            bytes = raw.stdout;
          } else {
            bytes = await readDurableTestObservation(root, report.path, {
              expectedSha256: report.sha256,
              expectedBytes: report.bytes
            });
          }
          if (createHash('sha256').update(bytes).digest('hex') !== report.sha256
              || (Number.isInteger(report.bytes) && bytes.length !== report.bytes)) {
            fail(`test receipt ${execution.commandId} raw report differs from its content address`);
            replayable = false;
            continue;
          }
          replayReports.push({ contents: bytes });
        } catch (error) {
          fail(`test receipt ${execution.commandId} raw report is unavailable: ${error.message}`);
          replayable = false;
        }
      }
      if (replayable && replayReports.length === observation.rawReports?.length) {
        try {
          const replay = testReceipt.adapter === 'junit-xml'
            ? replayLocalJunitObservation(replayReports)
            : replayLocalJavascriptJsonObservation(replayReports, testReceipt.adapter);
          if (canonicalJson(replay.tests) !== canonicalJson(testReceipt.tests)) {
            fail(`test receipt ${execution.commandId} module counts do not replay from its raw reports`);
          }
          const expectedRawOccurrences = exactReplay?.rawOccurrences ?? observation.occurrences ?? [];
          const parserMatches = observation.exact === true
            ? ['jdk-compiler-tree-api', 'sflow-javascript-static-parser'].includes(observation.parser?.id)
            : canonicalJson(replay.testcaseObservation.parser) === canonicalJson(observation.parser);
          if (!parserMatches
              || canonicalJson(replay.testcaseObservation.occurrences)
                !== canonicalJson(expectedRawOccurrences)) {
            fail(`test receipt ${execution.commandId} normalized testcase observation does not replay`);
          }
          if (replay.result.sha256 !== testReceipt.result?.sha256
              || replay.result.bytes !== testReceipt.result?.bytes) {
            fail(`test receipt ${execution.commandId} aggregate result binding does not replay`);
          }
          const storedFiles = testReceipt.result?.files ?? [];
          if (storedFiles.length !== replay.result.files.length
              || storedFiles.some((file, index) => !safeEvidencePath(file.sourcePath)
                || file.sha256 !== replay.result.files[index].sha256
                || file.bytes !== replay.result.files[index].bytes)) {
            fail(`test receipt ${execution.commandId} report-set binding does not replay`);
          }
        } catch (error) {
          fail(`test receipt ${execution.commandId} raw report replay failed: ${error.message}`);
        }
      }
    } else if (observation && (observation.assurance !== 'unavailable'
        || !['unavailable', 'unsupported'].includes(observation.status))) {
      fail(`test receipt ${execution.commandId} contains an unsupported testcase assurance claim`);
    }
    if (!testReceiptPassing(testReceipt, minimumDiscovered, minimumPassed)) fail(`test receipt ${execution.commandId} is not passing`);
    executions.set(execution.commandId, testReceipt);
  }
  if (!executions.size) fail('no passing test-execution receipt is bound');
  for (const binding of bindings) {
    const execution = executions.get(binding.commandId);
    if (!execution || !pathCoveredByRoots(binding.testSource, execution.affectedRoots)) {
      fail(`acceptance clause ${binding.clauseId} is not covered by its bound test command`);
    }
  }
  if (requireAffectedModuleCoverage) {
    for (const sourcePath of receipt.changeSet?.sourcePaths ?? []) {
      if (![...executions.values()].some((execution) => pathCoveredByRoots(sourcePath, execution.affectedRoots))) {
        fail(`affected source path ${sourcePath} has no passing module test receipt`);
      }
    }
  }
  if (!['policy-selected', 'provider-reported', 'host-observed', 'unavailable'].includes(receipt.model?.assurance)) {
    fail(`model assurance '${receipt.model?.assurance ?? ''}' is invalid`);
  }
  // The assurance floor governs model-authored code; it must not manufacture a mandatory model
  // dependency for explicitly human-authored delivery. Older v2 receipts did not record `required`,
  // so a real observation remains governed while an unavailable observation is treated as manual.
  const modelRequired = receipt.model?.required ?? receipt.model?.assurance !== 'unavailable';
  if (modelRequired && modelAssuranceRank(receipt.model?.assurance) < modelAssuranceRank(minimumModelAssurance)) {
    fail(`model assurance '${receipt.model?.assurance ?? 'unavailable'}' is below required '${minimumModelAssurance}'`);
  }
  if (receipt.model?.minimumAssurance != null
      && receipt.model.minimumAssurance !== minimumModelAssurance) {
    fail('model assurance minimum differs from the pinned policy');
  }
  if (receipt.model?.assurance === 'policy-selected' && !(receipt.model.invocationIds ?? []).length) {
    fail('policy-selected model assurance has no kernel invocation binding');
  }
  if (receipt.model?.assurance !== 'unavailable' && (!receipt.model?.provider || !receipt.model?.resolvedModel
      || receipt.model?.host !== 'singularity-flow-kernel'
      || receipt.model?.observationSource !== 'model-invocation-audit'
      || receipt.model?.observationIntegrity !== 'external-host-attested'
      || !receipt.model?.observedAt
      || Number(receipt.model?.generation) !== Number(receipt.generation)
      || !(receipt.model?.invocationIds ?? []).length)) {
    fail('model assurance is missing its provider/model, host audit source, timestamp, generation, or invocation binding');
  }
  return { valid: errors.length === 0, errors, changeSet, executions: [...executions.values()] };
}
