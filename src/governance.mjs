import { conformancePhasesOf } from './phase-roles.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { currentPhase, sourceTreeHash, validateWorkflow, workDir, workflowPublicationBranch } from './state-stores.mjs';
import { exists, gitHeadIsUnborn, gitReadOutput, nowIso, posix, snapshot, run } from './util.mjs';
import { verifyInputsIntegrity } from './inputs.mjs';
import { verifyAgentIntegrity } from './agents.mjs';
import { matchApprovalAuthority, remainingRequiredAuthorities } from './approval-authority.mjs';
import { verifyGroundingRecord } from './grounding.mjs';
import { verifyClarificationRecord } from './clarifications.mjs';
import { verifyPhaseTelemetry } from './telemetry.mjs';
import { verifyMcpEvidence } from './mcp.mjs';
import { verifyDesignSourceLifecycle } from './design-sources.mjs';
import { evaluateVisualCoverage } from './visual-coverage.mjs';
import { listVisualComparisons } from './visual-compare.mjs';
import { loadImpactDefinition } from './impact-config.mjs';
import { verifyImpactPlanBinding, verifyImpactReceipt } from './impact.mjs';
import {
  changedRepositoryPaths,
  configuredAcceptanceCommandSetSha256,
  evaluateSpecAcceptance,
  evaluateSpecCoverage,
  isSpecificationDefinitionPhase,
  loadActiveSpecRecords,
  loadBoundActiveSpecRecords,
  specificationSourceTreeHash
} from './specifications.mjs';
import { verifyAstLifecycleReceipt } from './ast-lifecycle.mjs';
import { blockingConformanceVerdicts } from './conformance-verdicts.mjs';
import { inspectQualifiedConformanceReport } from './conformance-readiness.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { evaluateStoryProtectedPaths } from './configuration-materialization.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { obligationsDroppedBySkips } from './workflow-decisions.mjs';
import { readRecord } from './schema-migrations.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { exactFileAtObject, firstParentCommitsMentioning, governedCommitIdentity, head } from './git.mjs';
import { documentUploadPhases, evidenceIsActive } from './documents.mjs';
import { documentNameKey } from './document-identity.mjs';
import { isLocalDocument, localDocumentAvailability, validLocalDocumentKey } from './document-storage.mjs';
import { verifyCodeDeliveryReceipt } from './delivery-evidence.mjs';
import { applicationPathContext } from './application-paths.mjs';
import { classifyStoryGateFailures } from './gate-recovery.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { configuredRemoteIdentity, frozenRemoteTransport, safeGitDiagnosticReference } from './git-remote-diagnostics.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { evaluateArchitectureIntentGate } from './architecture-intent-gate.mjs';
import { resolveStoryExecutionDefinition } from './story-execution-context.mjs';
import { verifyPhaseApprovalWaiver } from './approval-waiver.mjs';

function trackedFiles(root) { return run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean); }
function ids(text, pattern) { return [...new Set([...text.matchAll(pattern)].map((match) => match[0]))]; }
function traceabilitySources(workflow) {
  return workflow.phaseOrder.map((phaseId) => workflow.phases[phaseId]).filter((phase) => ['requirements', 'implementation-spec'].includes(phase?.requiredArtifact?.kind));
}

const CONFORMANCE_CODES = Object.freeze({
  'conformance.clause-row-missing': 'gate.conformance.missing-row',
  'conformance.verdict-invalid': 'gate.conformance.verdict-missing',
  'conformance.verdict-incomplete': 'gate.conformance.blocking-verdict'
});

/** A qualified conformance report's problems, each with its gate code. */
function qualifiedConformanceErrors(report, clauseIds) {
  return inspectQualifiedConformanceReport(report, clauseIds).map((finding) => ({
    code: CONFORMANCE_CODES[finding.code] ?? `gate.${finding.code}`, message: finding.message
  }));
}

export { approvedConfigurationMaterializations } from './configuration-materialization.mjs';

/** Compare terminal publication against the exact configured push authority, not a mutable name. */
export async function terminalPublicationObservation(root, remote, publicationBranch) {
  const identity = configuredRemoteIdentity(root, remote, { direction: 'push' });
  if (!identity.configured || identity.ambiguous) {
    return { published: false, reason: `${remote} has no unambiguous configured publication authority` };
  }
  const transport = frozenRemoteTransport(identity.url);
  const observed = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', transport.remote, `refs/heads/${publicationBranch}`
  ], { cwd: root, operation: 'remote-probe', env: transport.env });
  if (observed.status !== 0) {
    return { published: false, reason: safeGitDiagnosticReference(observed, 'Cannot verify published HEAD') };
  }
  const remoteHead = observed.stdout.trim().split(/\s+/)[0];
  const localHead = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  return { published: remoteHead === localHead, reason: null };
}

/**
 * When the Story reached its end, or now if it has not. Accepted risk and witness exceptions are
 * judged at this moment, so a later audit of a finished Story still sees what held when it finished.
 */
export function terminalTransitionAt(workflow) {
  if (workflow?.status !== 'closed') return nowIso();
  const settled = (workflow.phaseOrder ?? []).map((id) => workflow.phases?.[id])
    .flatMap((phase) => [phase?.approvedAt, phase?.skippedAt])
    .map((value) => Date.parse(value ?? '')).filter(Number.isFinite);
  return settled.length ? new Date(Math.max(...settled)).toISOString() : nowIso();
}

/**
 * Witness exceptions that lapsed before the Story finished. An exception is reviewed with an expiry;
 * once it lapses it no longer stands in for the evidence it excused.
 */
export function lapsedWitnessExceptions(workflow) {
  const finishedAt = Date.parse(terminalTransitionAt(workflow));
  const lapsed = [];
  for (const phaseId of workflow?.phaseOrder ?? []) {
    for (const approval of (workflow.phases?.[phaseId]?.approvals ?? []).filter((entry) => !entry?.invalidatedAt)) {
      for (const mapping of approval.witnessMappings ?? []) {
        if (mapping?.decision === 'exception' && !(Date.parse(mapping.expiresAt ?? '') > finishedAt)) {
          lapsed.push(`terminal: ${phaseId}'s witness exception for ${mapping.clauseId} expired at ${mapping.expiresAt ?? 'an unknown time'}, before the Story finished`);
        }
      }
    }
  }
  return lapsed;
}

export function generationAuthorship(phase, generation) {
  return [...(phase?.authorship ?? [])].reverse()
    .find((record) => Number(record.generation) === Number(generation))
    ?? { producer: 'legacy-unspecified', channel: 'legacy' };
}

/** Grounding governs a model-assisted prompt. Manual and deterministic producers sent no prompt. */
export function generationRequiresGrounding(phase, generation) {
  return ['governed-agent', 'legacy-unspecified'].includes(generationAuthorship(phase, generation).producer);
}

/**
 * Submission-grade evidence is required only after a generation crossed the review boundary.
 * A published draft that was superseded before submit remains immutable audit history, but it
 * cannot have the test receipt that submit intentionally creates later.
 */
export function generationReachedReview(workflow, phase, generation) {
  const phaseId = phase?.id;
  if ((workflow?.lineage?.submissions ?? []).some((entry) =>
    entry.phase === phaseId && Number(entry.generation) === Number(generation))) return true;
  if ((phase?.approvals ?? []).some((entry) => Number(entry.generation) === Number(generation))) return true;
  return Number(phase?.generation) === Number(generation)
    && (Boolean(phase?.submittedAt) || ['awaiting_approval', 'approved'].includes(phase?.status));
}

/**
 * Abandoned draft files may be absent only when the governed rollback proves that history.
 *
 * Each abandoned change request is verified on its own: one whose history cannot be read records
 * an error in `errors` and exempts nothing, while the others are still verified.
 */
export function verifiedAbandonedGenerations(root, config, workflow, { errors = [] } = {}) {
  const verified = new Set();
  const identities = new Map();
  const identityAt = (commit) => {
    if (!identities.has(commit)) identities.set(commit, governedCommitIdentity(root, commit));
    return identities.get(commit);
  };
  const relative = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'workflow.json'));
  const committedWorkflow = (commit) => {
    const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024 });
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
  };
  let tip = null;
  for (const request of workflow.changeRequests ?? []) {
    const discarded = request.resolution?.abandonedGenerations;
    if (request.status !== 'abandoned' || request.resolution?.status !== 'abandoned'
        || !Array.isArray(discarded) || !discarded.length) continue;
    try {
      const events = (workflow.publicationProjections ?? []).map((entry) => entry.event).filter((event) =>
        event?.type === 'rework-rolled-forward' && event.subject?.kind === 'story'
        && event.subject.id === workflow.workItem.id && event.payload?.changeRequestId === request.id
        && event.payload?.decision === 'abandoned'
        && event.payload?.checkpointId === request.forwardCheckpoint?.id
        && event.payload?.confirmation === request.resolution.confirmation);
      if (events.length !== 1) continue;
      const event = events[0];
      const eventSha256 = `sha256:${recordSha256(event)}`;
      tip ??= head(root);
      // The rollback commit was made after the rejection captured its forward checkpoint, so only
      // first-parent history after that checkpoint (and after the event's own source) can hold it.
      // A copied projection has no commit whose event trailer authenticates it: no exception.
      const identity = firstParentCommitsMentioning(root, eventSha256, {
        tip, after: [event.sourceCommit, request.forwardCheckpoint?.sourceCommit]
      }).map(identityAt).find((candidate) => candidate?.eventSha256 === eventSha256) ?? null;
      if (!identity?.transactionId || identity.parents.length !== 1
          || (event.sourceCommit && identity.parents[0] !== event.sourceCommit)) continue;
      const retained = committedWorkflow(identity.commit);
      const before = committedWorkflow(identity.parents[0]);
      const committed = retained?.changeRequests?.find((entry) => entry.id === request.id);
      const prior = before?.changeRequests?.find((entry) => entry.id === request.id);
      if (canonicalJson(committed?.resolution) !== canonicalJson(request.resolution)
          || committed?.status !== 'abandoned' || prior?.status !== 'open'
          || canonicalJson(committed.forwardCheckpoint) !== canonicalJson(prior.forwardCheckpoint)
          || !(retained?.publicationProjections ?? []).some((entry) =>
            canonicalJson(entry.event) === canonicalJson(event))
          || (before?.publicationProjections ?? []).some((entry) => entry.event?.eventId === event.eventId)) continue;
      const exempt = [];
      for (const { phase: phaseId, generation } of discarded) {
        const phase = workflow.phases?.[phaseId];
        if (!phase || !Number.isInteger(generation) || generation < 1 || generation === Number(phase.generation)
            || Number(before.phases?.[phaseId]?.generation ?? 0) < generation
            || Number(retained.phases?.[phaseId]?.generation ?? 0) >= generation) continue;
        const publication = publishedGenerationCommit(root, before, before.phases[phaseId], generation);
        if (publication) exempt.push(`${phaseId}:${generation}`);
      }
      // A request whose verification fails part-way exempts nothing.
      for (const key of exempt) verified.add(key);
    } catch (error) {
      errors.push(`abandoned rework ${request.id} could not be verified: ${error.message}`);
    }
  }
  return verified;
}

export async function runGovernanceGate(root, config, workflow, { terminal = false, pendingTransition = false } = {}) {
  config = await resolveStoryExecutionDefinition(root, config, workflow);
  const errors = [], warnings = [], passes = [];
  // Every error is also a coded finding naming the step and path it belongs to; recovery reads the
  // code and the step, never the wording [E2G-024].
  const coded = [];
  const refuse = (code, message, { phase = null, path: file = null } = {}) => {
    errors.push(message);
    coded.push({ code, message, phase, path: file });
  };
  const refuseEach = (code, messages, options) => { for (const message of messages ?? []) refuse(code, message, options); };
  const base = await validateWorkflow(root, config, workflow, { strict: true }); refuseEach('gate.state.invalid', base.errors); warnings.push(...base.warnings);
  for (const override of workflow.sequenceOverrides ?? []) {
    warnings.push(`soft sequence gate '${override.gate}' was overridden for ${override.requestedPhase ?? override.before?.currentPhase ?? 'workflow'} during ${override.action}`);
  }

  if (workflow.resolution.configSha256) {
    const current = await snapshot(path.join(root, 'singularity/workflow.yml'));
    if (current.sha256 !== workflow.resolution.configSha256) refuse('gate.configuration.snapshot-drift', 'workflow.yml differs from the immutable work-item configuration snapshot', { path: 'singularity/workflow.yml' });
    for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
      const present = await snapshot(path.join(root, template.path));
      if (present.sha256 !== template.sha256) refuse('gate.template.snapshot-drift', `template snapshot changed for ${phaseId}: ${template.path}`, { phase: phaseId, path: template.path });
    }
    if (workflow.resolution.sourceSha256) {
      const source = await snapshot(path.join(workDir(root, config, workflow.workItem.id), 'source.json'));
      if (source.sha256 !== workflow.resolution.sourceSha256) refuse('gate.source.snapshot-drift', 'source.json differs from the immutable source snapshot');
    }
    if (workflow.resolution.impact?.sha256) {
      if (workflow.measurement?.plan?.kind === 'prompt-set-randomized') {
        try {
          const binding = await verifyImpactPlanBinding(root, workflow);
          refuseEach('gate.impact.prompt-study', binding.errors.map((error) => `prompt study: ${error}`));
          if (binding.valid) passes.push(`prompt study assignment pinned: ${workflow.measurement.plan.studyRunId}/${workflow.measurement.plan.variantId}`);
        } catch (error) {
          refuse('gate.impact.prompt-study', `prompt study assignment is unavailable: ${error.message}`);
        }
      } else {
        try {
          const currentImpact = await loadImpactDefinition(root, { required: true });
          if (currentImpact.sha256 !== workflow.resolution.impact.sha256) {
            refuse('gate.impact.snapshot-drift', 'impact.yml differs from the immutable work-item impact-study snapshot');
          } else passes.push(`impact study configuration pinned: ${currentImpact.sha256.slice(0, 12)}`);
        } catch (error) {
          refuse('gate.impact.unavailable', `impact study configuration is unavailable: ${error.message}`);
        }
      }
    }
  }

  if (workflow.measurement?.receipt) {
    const verification = await verifyImpactReceipt(root, workflow);
    refuseEach('gate.impact.receipt', verification.errors.map((error) => `impact receipt: ${error}`));
    if (verification.valid) passes.push(`impact receipt verified: ${workflow.measurement.receipt.sha256.slice(0, 12)}`);
  }

  const documentManifest = path.join(workDir(root, config, workflow.workItem.id), 'documents.json');
  if (await exists(documentManifest)) {
    const manifest = readRecord('document-manifest', await readFile(documentManifest)).record; const seen = new Set();
    if (manifest.workId !== workflow.workItem.id) refuse('gate.documents.catalog', 'document catalog work ID does not match workflow');
    // The same phases the upload gate admits, the documents given at Story creation (part of its
    // opening record), and any phase a confirmed soft-gate override opened before the document was
    // added: that upload was audited, not outside the policy.
    const uploadPhases = documentUploadPhases(workflow, config);
    const overrides = (workflow.sequenceOverrides ?? []).filter((override) => override.gate === 'documentPhase');
    const admitted = (document) => uploadPhases.includes(document.phase)
      || (document.origin === 'story-start' && document.phase === workflow.phaseOrder?.[0])
      || overrides.some((override) => override.requestedPhase === document.phase
        && String(override.at ?? '') <= String(document.addedAt ?? ''));
    const names = new Map();
    for (const document of manifest.documents ?? []) {
      if (seen.has(document.id)) refuse('gate.documents.catalog', `duplicate document ID: ${document.id}`); seen.add(document.id);
      // Every lookup, prompt and citation resolves a document by its name, detached ones included.
      const nameKey = typeof document.name === 'string' && document.name.trim() ? documentNameKey(document.name) : null;
      if (!nameKey) refuse('gate.documents.catalog', `${document.id} has no document name`);
      else if (names.has(nameKey)) refuse('gate.documents.catalog', `${document.id} reuses the document name of ${names.get(nameKey)}`);
      else names.set(nameKey, document.id);
      if (document.phases != null && (!Array.isArray(document.phases) || !document.phases.length
          || document.phases.some((phaseId) => !(workflow.phaseOrder ?? []).includes(phaseId)))) {
        refuse('gate.documents.catalog', `${document.id} is offered to phases this Story does not have`);
      }
      if (!admitted(document)) refuse('gate.documents.policy', `${document.id} was uploaded outside the immutable document phase policy`, { phase: document.phase ?? null });
      if (!document.addedBy || !document.agent) refuse('gate.documents.catalog', `${document.id} is missing actor or agent attribution`);
      if (isLocalDocument(document)) {
        // Kept on one machine: the catalog commits its identity, never its bytes. Here it is either
        // the committed bytes, or not here at all, which is expected on every other machine.
        if (document.path != null) refuse('gate.documents.catalog', `${document.id} is kept on one machine but also names a repository path`);
        else if (!validLocalDocumentKey(document.storage.key)) refuse('gate.documents.catalog', `${document.id} has an invalid machine-local storage key`);
        else {
          const availability = await localDocumentAvailability(root, workflow.workItem.id, document, { verify: true });
          if (availability === 'changed') refuse('gate.documents.integrity', `document integrity failed: ${document.id} (kept on this machine, but the copy no longer matches its SHA-256)`);
          else if (availability === 'unavailable' && evidenceIsActive(document)) warnings.push(`${document.id} is kept on another machine; its integrity cannot be checked here`);
        }
      } else if (document.type === 'file') {
        const current = await snapshot(path.join(root, document.path));
        if (!current.exists || current.size !== document.size || current.sha256 !== document.sha256) refuse('gate.documents.integrity', `document integrity failed: ${document.id} (${document.path})`, { path: document.path });
      } else if (document.type === 'url' && !/^https?:\/\/\S+$/i.test(document.url ?? '')) refuse('gate.documents.catalog', `${document.id} has an invalid external URL`);
    }
    // `totalCount` counts every record and `count` the active ones. Older Stories wrote only `count`,
    // as the total after an upload, so a counter without `totalCount` is compared as the total.
    const records = manifest.documents ?? [];
    const counters = workflow.documents ?? {};
    const totalMatches = (counters.totalCount ?? counters.count ?? 0) === records.length;
    const activeMatches = counters.totalCount === undefined
      || (counters.count ?? 0) === records.filter(evidenceIsActive).length;
    if (!totalMatches || !activeMatches) refuse('gate.documents.catalog', 'workflow document count differs from documents.json');
    else passes.push(`document integrity: ${records.length} supporting inputs`);
  } else if ((workflow.documents?.count ?? 0) > 0) refuse('gate.documents.catalog', 'workflow records documents but documents.json is missing');

  const pinnedBase = workflow.workItem.baseCommit ?? null;
  const mergeBase = pinnedBase
    ? { status: 0, stdout: pinnedBase }
    : run('git', ['merge-base', workflow.workItem.baseBranch, 'HEAD'], { cwd: root, allowFailure: true });
  if (mergeBase.status === 0) {
    const branchChangeSet = await buildRepositoryChangeSet(root, { baseCommit: mergeBase.stdout.trim() });
    const protectedResult = evaluateStoryProtectedPaths(
      branchChangeSet, config.governance?.protectedPaths ?? [], workflow
    );
    for (const violation of protectedResult.violations) {
      refuse('gate.protected-path.changed', `protected process path changed on work branch: ${violation.path} (${violation.endpoint})`, { path: violation.path });
    }
    if (protectedResult.acceptedProtectedPaths.size) {
      passes.push(`approved configuration materialization: ${protectedResult.acceptedProtectedPaths.size} protected path(s) match the pinned configuration snapshot`);
    }
  } else warnings.push(`could not compare protected process paths with ${workflow.workItem.baseCommit ?? workflow.workItem.baseBranch}`);

  const abandonedErrors = [];
  const abandoned = verifiedAbandonedGenerations(root, config, workflow, { errors: abandonedErrors });
  refuseEach('gate.rework.abandoned-unverified', abandonedErrors);
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    for (let generation = 1; generation <= (phase.generation ?? 0); generation += 1) {
      if (abandoned.has(`${phaseId}:${generation}`)) {
        passes.push(`abandoned generation history verified: ${phaseId} generation ${generation}`);
        continue;
      }
      const subject = `[${workflow.workItem.id}][phase:${phase.id}][generated:${generation}]`;
      const publication = (phase.generationPublications ?? [])
        .find((entry) => Number(entry.generation) === Number(generation));
      let found = null;
      let publicationInvalid = false;
      if (publication?.record?.path) {
        try {
          const commit = publishedGenerationCommit(root, workflow, phase, generation);
          if (commit) {
            found = [commit, subject];
            passes.push(`generation publication verified: ${phaseId} generation ${generation} @ ${commit.slice(0, 12)}`);
          }
        } catch (error) {
          publicationInvalid = true;
          refuse('gate.generation.publication-invalid', error?.code === 'GIT_READ_UNAVAILABLE' ? error.message
            : `${phaseId} generation ${generation} publication record is invalid: ${error.message}`, { phase: phaseId });
        }
      } else {
        try {
          // A history Git could not read is not a generation without its required commit.
          found = (gitReadOutput(run('git', ['log', '--format=%H%x09%s', '--fixed-strings', '--grep', subject], {
            cwd: root, allowFailure: true
          }), `${phaseId} generation ${generation} commit`, { absentWhen: () => gitHeadIsUnborn(root) }) ?? '')
            .split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')).find(([, message]) => message.startsWith(subject));
        } catch (error) {
          if (error?.code !== 'GIT_READ_UNAVAILABLE') throw error;
          publicationInvalid = true;
          refuse('gate.generation.publication-invalid', error.message, { phase: phaseId });
        }
      }
      if (!found) {
        if (!publicationInvalid) refuse('gate.generation.commit-missing', `${phaseId} generation ${generation} has no required Git commit`, { phase: phaseId });
      } else if (config.git?.publish === 'required') {
        const remoteRef = `refs/remotes/${config.git.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}`;
        const published = run('git', ['merge-base', '--is-ancestor', found[0], remoteRef], { cwd: root, allowFailure: true });
        if (published.status !== 0) refuse('gate.publication.remote-missing', `${phaseId} generation ${generation} is not present on the remote branch`, { phase: phaseId });
      }
      let grounding = { errors: [], warnings: [], passes: [], record: null, path: null };
      if (generationRequiresGrounding(phase, generation)) {
        grounding = await verifyGroundingRecord(root, config, workflow, phase, {
          generation, superseded: generation < Number(phase.generation ?? 0)
        });
        refuseEach('gate.grounding.invalid', grounding.errors, { phase: phaseId }); warnings.push(...grounding.warnings); passes.push(...grounding.passes);
        if (grounding.path && await exists(path.join(root, grounding.path)) && found) {
          if (run('git', ['cat-file', '-e', `${found[0]}:${grounding.path}`], { cwd: root, allowFailure: true }).status !== 0) refuse('gate.grounding.uncommitted', `grounding composition was not committed with ${phaseId} generation ${generation}`, { phase: phaseId });
          else passes.push(`grounding audit committed: ${phaseId} generation ${generation}`);
          if (grounding.record?.promptPath && run('git', ['cat-file', '-e', `${found[0]}:${grounding.record.promptPath}`], { cwd: root, allowFailure: true }).status !== 0) refuse('gate.grounding.uncommitted', `grounding prompt snapshot was not committed with ${phaseId} generation ${generation}`, { phase: phaseId });
        }
      } else {
        passes.push(`grounding not applicable: ${phaseId} generation ${generation} was ${generationAuthorship(phase, generation).producer}`);
      }
      // Historical receipts are checked as immutable evidence at their generation commit. A later
      // phase may legitimately change a previously evaluated source file; only the active
      // publish-to-submit boundary re-evaluates live bytes.
      const ast = await verifyAstLifecycleReceipt(root, config, workflow, phase, {
        generation, revalidate: false, sourceCommit: found?.[0] ?? null
      });
      warnings.push(...ast.errors.map((error) => `optional AST evidence: ${error}`), ...ast.warnings);
      if (found) passes.push(...ast.passes);
      if (phaseRequiresCodeDelivery(phase)) {
        const reachedReview = generationReachedReview(workflow, phase, generation);
        const receiptPath = posix(path.join(
          config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
          'context', 'code-delivery', `${phase.id}-gen${generation}.json`
        ));
        if (!(await exists(path.join(root, receiptPath)))) {
          const generationStartPath = posix(path.join(
            config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
            'context', 'generation-start', `${phase.id}-gen${generation}.json`
          ));
          const v2Generation = phase.generationIntent?.generation === generation
            || await exists(path.join(root, generationStartPath))
            || Boolean(found && run('git', ['cat-file', '-e', `${found[0]}:${generationStartPath}`], {
              cwd: root, allowFailure: true
            }).status === 0);
          if (v2Generation && !reachedReview) {
            warnings.push(`${phaseId} generation ${generation} was superseded before review and has no draft code-delivery receipt`);
          } else {
            const message = `${phaseId} generation ${generation} has ${v2Generation ? 'no required' : 'legacy inline'} code-delivery evidence instead of a v2 receipt`;
            if (v2Generation) refuse('gate.code-delivery.receipt-missing', message, { phase: phaseId });
            else warnings.push(message);
          }
        } else if (!reachedReview) {
          passes.push(`superseded publication retained: ${phaseId} generation ${generation} did not enter review`);
        } else {
          const receipt = readRecord('code-delivery', await readFile(path.join(root, receiptPath))).record;
          if (receipt.legacyV1) {
            warnings.push(`${phaseId} generation ${generation} code-delivery receipt is readable legacy v1 evidence`);
          } else {
            if (found && receipt.tree?.generationCommit !== found[0]) refuse('gate.code-delivery.commit-mismatch', `${phaseId} generation ${generation} receipt names a different generation commit`, { phase: phaseId });
            let riskReplay = null;
            if (receipt.testRecovery) {
              const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find(entry =>
                entry.phase === phase.id && Number(entry.generation) === Number(generation));
              if (submission) {
                const { readStoryReviewPacket } = await import('./story-lineage.mjs');
                const packet = await readStoryReviewPacket(root, config, workflow, submission.packetSha256);
                if (packet.submissionEvidence?.codeDelivery?.path === receiptPath
                  && String(packet.submissionEvidence.codeDelivery.sha256).replace(/^sha256:/u, '')
                    === createHash('sha256').update(canonicalJson(receipt)).digest('hex')) {
                  // The terminal gate replays the decision as of the moment the Story finished: one
                  // revoked or expired before then no longer covers it. Other runs replay submission.
                  riskReplay = { evidenceCommit: packet.evidenceCommit,
                    testRecovery: { config, workflow, operation: 'submit', mode: 'historical',
                      at: terminal ? terminalTransitionAt(workflow) : receipt.validatedAt } };
                } else refuse('gate.code-delivery.packet-mismatch', `${phaseId} generation ${generation}: TRP delivery receipt differs from its immutable review packet`, { phase: phaseId });
              }
            }
            const replay = await verifyCodeDeliveryReceipt(root, receipt, {
              protectedPaths: [...new Set([
                ...(config.governance?.protectedPaths ?? []),
                ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
              ])],
              configurationSource: workflow.resolution?.configurationSource,
              sourceBoundary: phase.sourceBoundary,
              symlinkPolicy: workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject',
              minimumDiscovered: workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1,
              minimumPassed: workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1,
              requireAffectedModuleCoverage: workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false,
              minimumModelAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
              sourceBindingPolicy: workflow.resolution?.plannedClaims?.mode === 'required'
                && phase.sourceBoundary !== 'test-automation'
                ? workflow.resolution?.codeDelivery?.traceability?.sourceBindings ?? 'off' : 'off',
              pathContext: applicationPathContext(config, workflow),
              ...riskReplay
            });
            refuseEach('gate.code-delivery.replay', replay.errors.map((message) => `${phaseId} generation ${generation}: ${message}`), { phase: phaseId });
            if (replay.valid) passes.push(`code delivery verified: ${phaseId} generation ${generation}`);
          }
        }
      }
      const authorship = generationAuthorship(phase, generation);
      if (authorship?.producer === 'governed-agent') {
        const clarification = await verifyClarificationRecord(root, config, workflow, phase, { generation, groundingRecord: grounding.record });
        refuseEach('gate.clarification.invalid', clarification.errors, { phase: phaseId }); warnings.push(...clarification.warnings); passes.push(...clarification.passes);
        if (clarification.path && clarification.record && found) {
          if (run('git', ['cat-file', '-e', `${found[0]}:${clarification.path}`], { cwd: root, allowFailure: true }).status !== 0) refuse('gate.clarification.uncommitted', `clarification record was not committed with ${phaseId} generation ${generation}`, { phase: phaseId });
          else passes.push(`clarification audit committed: ${phaseId} generation ${generation}`);
        }
      }
      if (workflow.telemetry?.mode === 'work-item-sanitized' || (phase.telemetry ?? []).some((item) => item.generation === generation)) {
        const telemetry = await verifyPhaseTelemetry(root, workflow, phase, generation);
        refuseEach('gate.telemetry.invalid', telemetry.errors, { phase: phaseId }); passes.push(...telemetry.passes);
        const telemetryPath = (phase.telemetry ?? []).find((item) => item.generation === generation)?.path;
        if (found && telemetryPath && run('git', ['cat-file', '-e', `${found[0]}:${telemetryPath}`], { cwd: root, allowFailure: true }).status !== 0) refuse('gate.telemetry.uncommitted', `telemetry audit was not committed with ${phaseId} generation ${generation}`, { phase: phaseId });
      }
      const agentContextRelative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `agents-${phase.id}-gen${generation}.json`);
      if (await exists(path.join(root, agentContextRelative))) {
        if (found && run('git', ['cat-file', '-e', `${found[0]}:${agentContextRelative}`], { cwd: root, allowFailure: true }).status !== 0) refuse('gate.agents.context-uncommitted', `remote agent context was not committed with ${phaseId} generation ${generation}`, { phase: phaseId });
        else if (found) passes.push(`remote agent audit: ${phaseId} generation ${generation}`);
      }
      for (const output of (phase.remoteOutputs ?? []).filter((entry) => entry.generation === generation)) {
        const outputRecord = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${generation}.json`);
        if (!(await exists(path.join(root, outputRecord)))) refuse('gate.agents.remote-output-missing', `remote output provenance is missing: ${outputRecord}`, { phase: phaseId, path: outputRecord });
        else if (found && run('git', ['cat-file', '-e', `${found[0]}:${outputRecord}`], { cwd: root, allowFailure: true }).status !== 0) refuse('gate.agents.remote-output-uncommitted', `remote output provenance was not committed with ${phaseId} generation ${generation}`, { phase: phaseId, path: outputRecord });
      }
    }
    const inputIntegrity = await verifyInputsIntegrity(root, workflow, phase, {
      itemDirectory: workDir(root, config, workflow.workItem.id),
      itemRelative: path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id)
    });
    refuseEach('gate.inputs.integrity', inputIntegrity.errors, { phase: phaseId }); warnings.push(...inputIntegrity.warnings); passes.push(...inputIntegrity.passes);
    const agentIntegrity = await verifyAgentIntegrity(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    refuseEach('gate.agents.integrity', agentIntegrity.errors, { phase: phaseId }); warnings.push(...agentIntegrity.warnings); passes.push(...agentIntegrity.passes);
    if (phase.status !== 'approved') continue;
    const decisions = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved');
    const distinct = new Set(decisions.map((item) => item.actor?.login ?? item.actor?.email ?? item.actor?.name));
    const policyRequiresPeople = phase.approvalPolicy.mode !== 'none';
    const missingAuthorities = remainingRequiredAuthorities(phase.approvalPolicy, decisions);
    const peopleSatisfyPolicy = distinct.size >= (phase.approvalPolicy.minimum ?? 1) && !missingAuthorities.length;
    let waived = false;
    if (phase.approvalDisposition === 'policy_waived') {
      const replay = await verifyPhaseApprovalWaiver(root, config, workflow, phase, { pendingTransition });
      waived = replay.valid;
      if (waived) passes.push(replay.pending ? `policy waiver recorded by this transition: ${phaseId}` : `policy waiver verified: ${phaseId}`);
      else if (policyRequiresPeople && !peopleSatisfyPolicy) {
        refuseEach('gate.approval.waiver-invalid', replay.errors.map((message) => `${phaseId} policy waiver is invalid: ${message}`), { phase: phaseId });
      } else {
        // A waiver that does not replay never counts as approval, and fails the gate only when it
        // is what authorizes the phase. Approvals that satisfy the pinned policy authorize it
        // without one, so a record an earlier round left behind (older builds kept it) is reported.
        warnings.push(...replay.errors.map((message) => `${phaseId} policy waiver record is stale and was not relied on; the approval policy is met without it: ${message}`));
      }
    }
    const requiresApproval = policyRequiresPeople && !waived;
    if (requiresApproval && distinct.size < (phase.approvalPolicy.minimum ?? 1)) refuse('gate.approval.threshold', `${phaseId} has ${distinct.size} distinct approvals; requires ${phase.approvalPolicy.minimum ?? 1}`, { phase: phaseId });
    if (requiresApproval && missingAuthorities.length) refuse('gate.approval.required-authority', `${phaseId} is missing required authority decisions from: ${missingAuthorities.join(', ')}`, { phase: phaseId });
    for (const decision of decisions) {
      const authority = matchApprovalAuthority(
        workflow.resolution.approvalAuthorities,
        { ...phase.approvalPolicy, authorities: [decision.authorityGroup] },
        decision.actor
      );
      if (!authority.authorized) refuse('gate.approval.unauthorized', `${phaseId} approval by '${decision.actor?.email ?? decision.actor?.login ?? decision.actor?.name ?? 'unknown'}' lacks configured authority`, { phase: phaseId });
      else if (decision.authorityGroup !== authority.authorityGroup) refuse('gate.approval.authority-mismatch', `${phaseId} approval authority record does not match the pinned policy`, { phase: phaseId });
      if (!decision.identityAssurance) refuse('gate.approval.assurance-missing', `${phaseId} approval is missing identity-assurance metadata`, { phase: phaseId });
      if (decision.selfApproval) warnings.push(`${phaseId} is self-approved by ${decision.actor?.name ?? 'unknown'}; governed agent '${decision.agent ?? 'unavailable'}' is execution context, not independent review`);
    }
    for (const artifact of phase.artifacts) {
      const current = await snapshot(path.join(root, artifact.path));
      if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) refuse('gate.approval.stale', `STALE ${phaseId} approval: ${artifact.path} changed after approval`, { phase: phaseId, path: artifact.path });
    }
    const required = path.join(root, config.workItemRoot, workflow.workItem.id, phase.requiredArtifact.path);
    const text = await readFile(required, 'utf8').catch(() => '');
    if (decisions.some((item) => item.selfApproval) && !/"selfApproval": true/.test(text)) refuse('gate.approval.self-approval-undisclosed', `${phaseId} artifact does not expose its self-approval warning`, { phase: phaseId });
    passes.push(`approval integrity: ${phaseId}`);
  }

  const mcpIntegrity = await verifyMcpEvidence(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  refuseEach('gate.mcp.integrity', mcpIntegrity.errors); warnings.push(...mcpIntegrity.warnings); passes.push(...mcpIntegrity.passes);

  const designSourceIntegrity = await verifyDesignSourceLifecycle(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  refuseEach('gate.design-source.integrity', designSourceIntegrity.errors);
  warnings.push(...designSourceIntegrity.warnings);
  passes.push(...designSourceIntegrity.passes);

  const visualCoverage = await evaluateVisualCoverage(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  if (visualCoverage.mode === 'enforce') refuseEach('gate.visual.coverage', visualCoverage.errors); else warnings.push(...visualCoverage.errors);
  warnings.push(...visualCoverage.warnings);
  if (visualCoverage.status === 'pass') passes.push(`visual coverage: ${visualCoverage.covered.length}/${visualCoverage.profiles.length} profiles`);
  const comparisons = await listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  for (const comparison of comparisons) {
    // Evidence that will not parse is an integrity failure, not a threshold decision, so it fails
    // the gate whatever the comparison mode says. Otherwise damaging a record is a way past it.
    if (comparison.unreadable) refuse('gate.visual.evidence-unreadable', `visual comparison evidence ${comparison.path} could not be read: ${comparison.error}`, { path: comparison.path });
    else if (comparison.status === 'fail' && workflow.resolution?.verification?.comparison?.mode === 'enforce') refuse('gate.visual.threshold', `visual comparison ${comparison.id} exceeds policy thresholds`);
    else if (comparison.status !== 'pass') warnings.push(`visual comparison ${comparison.id}: ${comparison.status}`);
  }
  if (comparisons.length) passes.push(`visual comparisons: ${comparisons.length} deterministic result(s)`);

  const specPolicy = workflow.resolution?.spec ?? config.spec ?? { mode: 'off', coverage: 'off' };
  if (specPolicy.mode !== 'off') {
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const records = terminal && workflow.resolution?.plannedClaims?.mode === 'required'
      ? await loadBoundActiveSpecRecords(root, itemDirectory, workflow, specPolicy)
      : await loadActiveSpecRecords(itemDirectory, workflow);
    const fail = (code, message, phase) => (specPolicy.mode === 'enforce' ? refuse(code, message, { phase }) : warnings.push(message));
    for (const phaseId of workflow.phaseOrder) {
      const phase = workflow.phases[phaseId];
      if (!(phase.generation > 0) || !isSpecificationDefinitionPhase(phase)) continue;
      const index = records.indexes.find((candidate) => candidate.phase === phaseId && candidate.generation === phase.generation);
      if (!index) {
        fail('gate.specification-index.missing', `${phaseId} generation ${phase.generation} has no deterministic specification index`, phaseId);
        continue;
      }
      const artifact = await snapshot(path.join(root, index.source.path));
      // `phase.specIndex` is the same fact recorded in the aggregate when the generation was
      // published — a different file, written by the publication and never edited afterwards. It was
      // written and read by nothing, which left this check comparing a hash to the artifact it was
      // computed from and to the index file it lives inside: edit both together and everything
      // passes. Comparing against the aggregate is what makes that edit detectable.
      const anchor = phase.specIndex?.generation === phase.generation ? phase.specIndex : null;
      const drift = anchor && (anchor.sourceSha256 !== index.source.sha256
        || anchor.clauses !== index.clauses.length
        || (anchor.indexSha256 && index.indexSha256 && anchor.indexSha256 !== index.indexSha256));
      if (!artifact.exists || artifact.sha256 !== index.source.sha256) fail('gate.specification-index.stale', `${phaseId} specification index is stale for ${index.source.path}`, phaseId);
      else if (drift) {
        fail('gate.specification-index.stale', `${phaseId} specification index does not match the generation recorded in the workflow: `
          + `expected ${anchor.clauses} clause(s) for source ${String(anchor.sourceSha256).slice(0, 12)}, `
          + `found ${index.clauses.length} for ${String(index.source.sha256).slice(0, 12)}`, phaseId);
      }
      else passes.push(`specification clauses: ${phaseId} generation ${phase.generation} · ${index.clauses.length}`);
    }
    if (specPolicy.coverage !== 'off') {
      const observedCoverage = evaluateSpecCoverage(records, changedRepositoryPaths(root, {
        base: workflow.workItem.baseCommit
          ?? workflow.phases[workflow.phaseOrder[0]]?.sourceCommit
          ?? workflow.workItem.baseBranch,
        target: 'HEAD',
        pathContext: applicationPathContext(config, workflow)
      }), specPolicy, { root });
      // Only a code step records an observed claim. A route with none (a work type that builds
      // nothing, or an end that skipped its code steps) implements its clauses through the steps
      // that hold implementation, and the evidence evaluation judges those; counting them here
      // would call every such clause unimplemented.
      const codeRoute = workflow.phaseOrder.some((id) => phaseRequiresCodeDelivery(workflow.phases[id])
        && workflow.phases[id].status !== 'skipped');
      const coverage = codeRoute ? observedCoverage : (() => {
        const complete = !observedCoverage.unclaimedChangedPaths.length && !observedCoverage.withdrawnButClaimed.length
          && !observedCoverage.invalidEvidence.length;
        return { ...observedCoverage, unimplemented: [], complete, severity: complete ? 'pass' : observedCoverage.severity };
      })();
      const unimplemented = coverage.unimplemented.map((id) => ({ code: 'gate.clause.unimplemented', message: `clause ${id} is not fully implemented` }));
      const unclaimed = coverage.unclaimedChangedPaths.map((file) => ({ code: 'gate.clause.unclaimed-path', message: `changed path is not claimed by a clause: ${file}`, path: file }));
      const withdrawn = coverage.withdrawnButClaimed.map((id) => ({ code: 'gate.clause.withdrawn-claimed', message: `withdrawn clause still has an observed claim: ${id}` }));
      const invalid = coverage.invalidEvidence.map((message) => ({ code: 'gate.clause.invalid-evidence', message: `invalid clause evidence: ${message}` }));
      const refuseCoded = (entries) => { for (const entry of entries) refuse(entry.code, entry.message, { path: entry.path ?? null }); };
      if (coverage.severity === 'error') refuseCoded([...unimplemented, ...unclaimed, ...withdrawn, ...invalid]);
      else if (coverage.severity === 'warning') {
        // Record-mode coverage remains advisory during Code, but a new qualified terminal
        // conformance report cannot claim `matched` where observed clause evidence is absent.
        const terminalClauseContract = terminal && specPolicy.conformanceRows === 'qualified'
          && records.indexes.some((index) => (index.clauses ?? []).length > 0);
        if (terminalClauseContract) {
          refuseCoded([...unimplemented, ...withdrawn, ...invalid]);
          warnings.push(...unclaimed.map((entry) => entry.message));
        } else warnings.push(...[...unimplemented, ...unclaimed, ...withdrawn, ...invalid].map((entry) => entry.message));
      }
      if (coverage.complete) passes.push(`clause coverage: ${coverage.totals.observed}/${coverage.totals.clauses} clauses, ${coverage.totals.changedPaths} changed paths`);
    }
    if (specPolicy.acceptance !== 'off') {
      const acceptance = evaluateSpecAcceptance(records, specPolicy, {
        workId: workflow.workItem.id,
        sourceTreeSha256: await specificationSourceTreeHash(
          root, applicationPathContext(config, workflow)
        ),
        commandSetSha256: configuredAcceptanceCommandSetSha256(specPolicy)
      });
      const entries = [
        ...acceptance.missingPlannedTests.map((id) => ({ code: 'gate.acceptance.planned-test-missing', message: `clause ${id} has no planned test` })),
        ...acceptance.missingObservedTests.map((id) => ({ code: 'gate.acceptance.observed-test-missing', message: `clause ${id} has no observed test result` })),
        ...acceptance.failedCommands.map((id) => ({ code: 'gate.acceptance.command-failed', message: `allowlisted acceptance command failed: ${id}` })),
        ...(acceptance.missingRun ? [{ code: 'gate.acceptance.run-missing', message: 'no specification acceptance run is recorded' }] : []),
        ...acceptance.staleRunReasons.map((reason) => ({ code: 'gate.acceptance.run-stale', message: `specification acceptance is stale: ${reason}` }))
      ];
      if (acceptance.complete) passes.push(`specification acceptance: ${acceptance.mode}`);
      else if (specPolicy.mode === 'enforce') for (const entry of entries) refuse(entry.code, entry.message);
      else warnings.push(...entries.map((entry) => entry.message));
    }
  }

  if (config.governance?.requireAcceptanceCriteriaTags) {
    const required = new Set();
    const bound = new Set();
    for (const phase of Object.values(workflow.phases).filter(phaseRequiresCodeDelivery)) {
      for (const id of phase.deliveryEvidence?.acceptanceCriteria?.required ?? []) required.add(id);
      for (const id of phase.deliveryEvidence?.acceptanceCriteria?.tagged ?? []) bound.add(id);
    }
    for (const id of required) if (!bound.has(id)) refuse('gate.acceptance-criteria.unbound', `AC coverage: ${id} has no module test-source binding`);
    if (required.size && [...required].every((id) => bound.has(id))) passes.push(`acceptance coverage: ${required.size} namespaced criteria mapped`);
  }

  if (terminal) {
    const configuredArchitectureGates = workflow.resolution?.architectureIntent?.blockRequiredUnfulfilledAt
      ?? config.architectureIntent?.blockRequiredUnfulfilledAt ?? [];
    for (const phaseId of configuredArchitectureGates) {
      const result = await evaluateArchitectureIntentGate(root, config, workflow, phaseId);
      refuseEach('gate.architecture.intent', result.errors.map((message) => `${phaseId}: ${message}`), { phase: phaseId });
      warnings.push(...result.warnings.map((message) => `${phaseId}: ${message}`));
      passes.push(...result.passes);
    }
  }

  // Every conformance report is governed alike, whatever its step is called [E2G-001]: its rows,
  // its disclosure of self-approval, its verdicts and its freshness against the tree it compared.
  for (const phase of conformancePhasesOf(workflow).filter((candidate) => candidate.generation > 0)) {
    const reportPath = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path); const report = await readFile(reportPath, 'utf8');
    const expected = new Set();
    // The stronger row contract is pinned into new Stories. Historical Story snapshots retain
    // their original substring check; a framework upgrade must not retroactively reject a report
    // that was authored and approved under the older contract.
    const qualifiedRows = terminal && specPolicy.conformanceRows === 'qualified'
      ? (await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow))
        .indexes.flatMap((index) => index.clauses ?? []).map((clause) => clause.id)
      : [];
    if (qualifiedRows.length) {
      qualifiedRows.forEach((id) => expected.add(id));
      for (const entry of qualifiedConformanceErrors(report, qualifiedRows)) refuse(entry.code, entry.message, { phase: phase.id });
    } else {
      for (const source of traceabilitySources(workflow)) {
        const text = await readFile(path.join(workDir(root, config, workflow.workItem.id), source.requiredArtifact.path), 'utf8').catch(() => '');
        ids(text, /\b(?:AC|SPEC)-\d+\b/g).forEach((id) => expected.add(id));
      }
      for (const id of expected) if (!report.includes(id)) refuse('gate.conformance.missing-row', `conformance report has no row for ${id}`, { phase: phase.id });
    }
    for (const [phaseId, prior] of Object.entries(workflow.phases)) {
      for (const approval of prior.approvals.filter((item) => !item.invalidatedAt && item.selfApproval)) {
        const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name;
        if (!report.includes(phaseId) || (actor && !report.includes(actor))) refuse('gate.conformance.self-approval-undisclosed', `conformance report does not disclose self-approval for ${phaseId} by ${actor}`, { phase: phase.id });
      }
    }
    if (!/\b(matched|partial|missing|deviated|unplanned)\b/.test(report)) refuse('gate.conformance.verdict-missing', 'conformance report has no recognized verdict', { phase: phase.id });
    if (!qualifiedRows.length) {
      for (const finding of blockingConformanceVerdicts(report)) {
        refuse('gate.conformance.blocking-verdict', `conformance ${finding.clauseId} remains ${finding.verdict}`, { phase: phase.id });
      }
    }
    if (phase.conformanceTree !== await sourceTreeHash(root, config, workflow)) refuse('gate.conformance.stale', 'conformance report is stale: source/test tree changed after comparison', { phase: phase.id });
    else passes.push(`conformance freshness: ${expected.size} traced identifiers`);
  }

  // A transition being evaluated before its own commit is published by that transaction, which
  // rolls back if the push fails, so only a finished Story is checked against its remote.
  if (config.git?.publish === 'required' && terminal && !pendingTransition) {
    const remote = config.git.remote ?? 'origin';
    const publicationBranch = workflowPublicationBranch(root, workflow);
    const observation = await terminalPublicationObservation(root, remote, publicationBranch);
    if (!observation.published) refuse('gate.publication.remote-missing', `terminal: ${observation.reason ?? `local HEAD is not published to ${remote}/${publicationBranch}`}`);
    else passes.push('remote publication');
  }

  if (terminal) {
    const dropped = new Map(obligationsDroppedBySkips(workflow).map((entry) => [entry.phase, entry.reason]));
    for (const phaseId of workflow.phaseOrder) {
      const phase = workflow.phases[phaseId];
      // A decision may skip a phase. The skip settles the phase only when it drops nothing that was
      // already accepted or planned; otherwise the Story would finish with those obligations unmet.
      if (phase?.status === 'skipped') {
        const route = phase.skippedBy ? ` (${phase.skippedBy.decision} → ${phase.skippedBy.route})` : '';
        if (dropped.has(phaseId)) refuse('gate.terminal.phase-skipped', `terminal: phase ${phaseId} was skipped by decision${route}, so ${dropped.get(phaseId)}`, { phase: phaseId });
        else passes.push(`skipped by decision: ${phaseId}${route}`);
      } else if (phase?.status !== 'approved') refuse('gate.terminal.phase-unapproved', `terminal: phase ${phaseId} is not approved`, { phase: phaseId });
    }
    refuseEach('gate.witness.exception-lapsed', lapsedWitnessExceptions(workflow));
    if (workflow.pendingDecision) refuse('gate.terminal.decision-pending', `terminal: the Story is waiting for a decision: ${workflow.pendingDecision.label}`, { phase: workflow.pendingDecision.after ?? null });
    if (workflow.status !== 'closed' || currentPhase(workflow)) refuse('gate.terminal.workflow-incomplete', 'terminal: workflow is not closed'); else passes.push('terminal lifecycle');
  }
  return { errors, warnings, passes, findings: classifyStoryGateFailures(workflow, coded) };
}
