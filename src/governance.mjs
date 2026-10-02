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

function qualifiedConformanceErrors(report, clauseIds) {
  return inspectQualifiedConformanceReport(report, clauseIds).map((finding) => finding.message);
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
  if (workflow?.status !== 'complete') return nowIso();
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

export async function runGovernanceGate(root, config, workflow, { terminal = false } = {}) {
  config = await resolveStoryExecutionDefinition(root, config, workflow);
  const errors = [], warnings = [], passes = [];
  const base = await validateWorkflow(root, config, workflow, { strict: true }); errors.push(...base.errors); warnings.push(...base.warnings);
  for (const override of workflow.sequenceOverrides ?? []) {
    warnings.push(`soft sequence gate '${override.gate}' was overridden for ${override.requestedPhase ?? override.before?.currentPhase ?? 'workflow'} during ${override.action}`);
  }

  if (workflow.resolution.configSha256) {
    const current = await snapshot(path.join(root, 'singularity/workflow.yml'));
    if (current.sha256 !== workflow.resolution.configSha256) errors.push('workflow.yml differs from the immutable work-item configuration snapshot');
    for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
      const present = await snapshot(path.join(root, template.path));
      if (present.sha256 !== template.sha256) errors.push(`template snapshot changed for ${phaseId}: ${template.path}`);
    }
    if (workflow.resolution.sourceSha256) {
      const source = await snapshot(path.join(workDir(root, config, workflow.workItem.id), 'source.json'));
      if (source.sha256 !== workflow.resolution.sourceSha256) errors.push('source.json differs from the immutable source snapshot');
    }
    if (workflow.resolution.impact?.sha256) {
      if (workflow.measurement?.plan?.kind === 'prompt-set-randomized') {
        try {
          const binding = await verifyImpactPlanBinding(root, workflow);
          errors.push(...binding.errors.map((error) => `prompt study: ${error}`));
          if (binding.valid) passes.push(`prompt study assignment pinned: ${workflow.measurement.plan.studyRunId}/${workflow.measurement.plan.variantId}`);
        } catch (error) {
          errors.push(`prompt study assignment is unavailable: ${error.message}`);
        }
      } else {
        try {
          const currentImpact = await loadImpactDefinition(root, { required: true });
          if (currentImpact.sha256 !== workflow.resolution.impact.sha256) {
            errors.push('impact.yml differs from the immutable work-item impact-study snapshot');
          } else passes.push(`impact study configuration pinned: ${currentImpact.sha256.slice(0, 12)}`);
        } catch (error) {
          errors.push(`impact study configuration is unavailable: ${error.message}`);
        }
      }
    }
  }

  if (workflow.measurement?.receipt) {
    const verification = await verifyImpactReceipt(root, workflow);
    errors.push(...verification.errors.map((error) => `impact receipt: ${error}`));
    if (verification.valid) passes.push(`impact receipt verified: ${workflow.measurement.receipt.sha256.slice(0, 12)}`);
  }

  const documentManifest = path.join(workDir(root, config, workflow.workItem.id), 'documents.json');
  if (await exists(documentManifest)) {
    const manifest = readRecord('document-manifest', await readFile(documentManifest)).record; const seen = new Set();
    if (manifest.workId !== workflow.workItem.id) errors.push('document catalog work ID does not match workflow');
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
      if (seen.has(document.id)) errors.push(`duplicate document ID: ${document.id}`); seen.add(document.id);
      // Every lookup, prompt and citation resolves a document by its name, detached ones included.
      const nameKey = typeof document.name === 'string' && document.name.trim() ? documentNameKey(document.name) : null;
      if (!nameKey) errors.push(`${document.id} has no document name`);
      else if (names.has(nameKey)) errors.push(`${document.id} reuses the document name of ${names.get(nameKey)}`);
      else names.set(nameKey, document.id);
      if (document.phases != null && (!Array.isArray(document.phases) || !document.phases.length
          || document.phases.some((phaseId) => !(workflow.phaseOrder ?? []).includes(phaseId)))) {
        errors.push(`${document.id} is offered to phases this Story does not have`);
      }
      if (!admitted(document)) errors.push(`${document.id} was uploaded outside the immutable document phase policy`);
      if (!document.addedBy || !document.agent) errors.push(`${document.id} is missing actor or agent attribution`);
      if (isLocalDocument(document)) {
        // Kept on one machine: the catalog commits its identity, never its bytes. Here it is either
        // the committed bytes, or not here at all, which is expected on every other machine.
        if (document.path != null) errors.push(`${document.id} is kept on one machine but also names a repository path`);
        else if (!validLocalDocumentKey(document.storage.key)) errors.push(`${document.id} has an invalid machine-local storage key`);
        else {
          const availability = await localDocumentAvailability(root, workflow.workItem.id, document, { verify: true });
          if (availability === 'changed') errors.push(`document integrity failed: ${document.id} (kept on this machine, but the copy no longer matches its SHA-256)`);
          else if (availability === 'unavailable' && evidenceIsActive(document)) warnings.push(`${document.id} is kept on another machine; its integrity cannot be checked here`);
        }
      } else if (document.type === 'file') {
        const current = await snapshot(path.join(root, document.path));
        if (!current.exists || current.size !== document.size || current.sha256 !== document.sha256) errors.push(`document integrity failed: ${document.id} (${document.path})`);
      } else if (document.type === 'url' && !/^https?:\/\/\S+$/i.test(document.url ?? '')) errors.push(`${document.id} has an invalid external URL`);
    }
    // `totalCount` counts every record and `count` the active ones. Older Stories wrote only `count`,
    // as the total after an upload, so a counter without `totalCount` is compared as the total.
    const records = manifest.documents ?? [];
    const counters = workflow.documents ?? {};
    const totalMatches = (counters.totalCount ?? counters.count ?? 0) === records.length;
    const activeMatches = counters.totalCount === undefined
      || (counters.count ?? 0) === records.filter(evidenceIsActive).length;
    if (!totalMatches || !activeMatches) errors.push('workflow document count differs from documents.json');
    else passes.push(`document integrity: ${records.length} supporting inputs`);
  } else if ((workflow.documents?.count ?? 0) > 0) errors.push('workflow records documents but documents.json is missing');

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
      errors.push(`protected process path changed on work branch: ${violation.path} (${violation.endpoint})`);
    }
    if (protectedResult.acceptedProtectedPaths.size) {
      passes.push(`approved configuration materialization: ${protectedResult.acceptedProtectedPaths.size} protected path(s) match the pinned configuration snapshot`);
    }
  } else warnings.push(`could not compare protected process paths with ${workflow.workItem.baseCommit ?? workflow.workItem.baseBranch}`);

  const abandoned = verifiedAbandonedGenerations(root, config, workflow, { errors });
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
          errors.push(error?.code === 'GIT_READ_UNAVAILABLE' ? error.message
            : `${phaseId} generation ${generation} publication record is invalid: ${error.message}`);
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
          errors.push(error.message);
        }
      }
      if (!found) {
        if (!publicationInvalid) errors.push(`${phaseId} generation ${generation} has no required Git commit`);
      } else if (config.git?.publish === 'required') {
        const remoteRef = `refs/remotes/${config.git.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}`;
        const published = run('git', ['merge-base', '--is-ancestor', found[0], remoteRef], { cwd: root, allowFailure: true });
        if (published.status !== 0) errors.push(`${phaseId} generation ${generation} is not present on the remote branch`);
      }
      let grounding = { errors: [], warnings: [], passes: [], record: null, path: null };
      if (generationRequiresGrounding(phase, generation)) {
        grounding = await verifyGroundingRecord(root, config, workflow, phase, {
          generation, superseded: generation < Number(phase.generation ?? 0)
        });
        errors.push(...grounding.errors); warnings.push(...grounding.warnings); passes.push(...grounding.passes);
        if (grounding.path && await exists(path.join(root, grounding.path)) && found) {
          if (run('git', ['cat-file', '-e', `${found[0]}:${grounding.path}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`grounding composition was not committed with ${phaseId} generation ${generation}`);
          else passes.push(`grounding audit committed: ${phaseId} generation ${generation}`);
          if (grounding.record?.promptPath && run('git', ['cat-file', '-e', `${found[0]}:${grounding.record.promptPath}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`grounding prompt snapshot was not committed with ${phaseId} generation ${generation}`);
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
            (v2Generation ? errors : warnings).push(
              `${phaseId} generation ${generation} has ${v2Generation ? 'no required' : 'legacy inline'} code-delivery evidence instead of a v2 receipt`
            );
          }
        } else if (!reachedReview) {
          passes.push(`superseded publication retained: ${phaseId} generation ${generation} did not enter review`);
        } else {
          const receipt = readRecord('code-delivery', await readFile(path.join(root, receiptPath))).record;
          if (receipt.legacyV1) {
            warnings.push(`${phaseId} generation ${generation} code-delivery receipt is readable legacy v1 evidence`);
          } else {
            if (found && receipt.tree?.generationCommit !== found[0]) errors.push(`${phaseId} generation ${generation} receipt names a different generation commit`);
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
                } else errors.push(`${phaseId} generation ${generation}: TRP delivery receipt differs from its immutable review packet`);
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
            errors.push(...replay.errors.map((message) => `${phaseId} generation ${generation}: ${message}`));
            if (replay.valid) passes.push(`code delivery verified: ${phaseId} generation ${generation}`);
          }
        }
      }
      const authorship = generationAuthorship(phase, generation);
      if (authorship?.producer === 'governed-agent') {
        const clarification = await verifyClarificationRecord(root, config, workflow, phase, { generation, groundingRecord: grounding.record });
        errors.push(...clarification.errors); warnings.push(...clarification.warnings); passes.push(...clarification.passes);
        if (clarification.path && clarification.record && found) {
          if (run('git', ['cat-file', '-e', `${found[0]}:${clarification.path}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`clarification record was not committed with ${phaseId} generation ${generation}`);
          else passes.push(`clarification audit committed: ${phaseId} generation ${generation}`);
        }
      }
      if (workflow.telemetry?.mode === 'work-item-sanitized' || (phase.telemetry ?? []).some((item) => item.generation === generation)) {
        const telemetry = await verifyPhaseTelemetry(root, workflow, phase, generation);
        errors.push(...telemetry.errors); passes.push(...telemetry.passes);
        const telemetryPath = (phase.telemetry ?? []).find((item) => item.generation === generation)?.path;
        if (found && telemetryPath && run('git', ['cat-file', '-e', `${found[0]}:${telemetryPath}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`telemetry audit was not committed with ${phaseId} generation ${generation}`);
      }
      const agentContextRelative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `agents-${phase.id}-gen${generation}.json`);
      if (await exists(path.join(root, agentContextRelative))) {
        if (found && run('git', ['cat-file', '-e', `${found[0]}:${agentContextRelative}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`remote agent context was not committed with ${phaseId} generation ${generation}`);
        else if (found) passes.push(`remote agent audit: ${phaseId} generation ${generation}`);
      }
      for (const output of (phase.remoteOutputs ?? []).filter((entry) => entry.generation === generation)) {
        const outputRecord = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${generation}.json`);
        if (!(await exists(path.join(root, outputRecord)))) errors.push(`remote output provenance is missing: ${outputRecord}`);
        else if (found && run('git', ['cat-file', '-e', `${found[0]}:${outputRecord}`], { cwd: root, allowFailure: true }).status !== 0) errors.push(`remote output provenance was not committed with ${phaseId} generation ${generation}`);
      }
    }
    const inputIntegrity = await verifyInputsIntegrity(root, workflow, phase, {
      itemDirectory: workDir(root, config, workflow.workItem.id),
      itemRelative: path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id)
    });
    errors.push(...inputIntegrity.errors); warnings.push(...inputIntegrity.warnings); passes.push(...inputIntegrity.passes);
    const agentIntegrity = await verifyAgentIntegrity(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    errors.push(...agentIntegrity.errors); warnings.push(...agentIntegrity.warnings); passes.push(...agentIntegrity.passes);
    if (phase.status !== 'approved') continue;
    const decisions = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved');
    const distinct = new Set(decisions.map((item) => item.actor?.login ?? item.actor?.email ?? item.actor?.name));
    const policyRequiresPeople = phase.approvalPolicy.mode !== 'none';
    const missingAuthorities = remainingRequiredAuthorities(phase.approvalPolicy, decisions);
    const peopleSatisfyPolicy = distinct.size >= (phase.approvalPolicy.minimum ?? 1) && !missingAuthorities.length;
    let waived = false;
    if (phase.approvalDisposition === 'policy_waived') {
      const replay = await verifyPhaseApprovalWaiver(root, config, workflow, phase);
      waived = replay.valid;
      if (waived) passes.push(`policy waiver verified: ${phaseId}`);
      else if (policyRequiresPeople && !peopleSatisfyPolicy) {
        errors.push(...replay.errors.map((message) => `${phaseId} policy waiver is invalid: ${message}`));
      } else {
        // A waiver that does not replay never counts as approval, and fails the gate only when it
        // is what authorizes the phase. Approvals that satisfy the pinned policy authorize it
        // without one, so a record an earlier round left behind (older builds kept it) is reported.
        warnings.push(...replay.errors.map((message) => `${phaseId} policy waiver record is stale and was not relied on; the approval policy is met without it: ${message}`));
      }
    }
    const requiresApproval = policyRequiresPeople && !waived;
    if (requiresApproval && distinct.size < (phase.approvalPolicy.minimum ?? 1)) errors.push(`${phaseId} has ${distinct.size} distinct approvals; requires ${phase.approvalPolicy.minimum ?? 1}`);
    if (requiresApproval && missingAuthorities.length) errors.push(`${phaseId} is missing required authority decisions from: ${missingAuthorities.join(', ')}`);
    for (const decision of decisions) {
      const authority = matchApprovalAuthority(
        workflow.resolution.approvalAuthorities,
        { ...phase.approvalPolicy, authorities: [decision.authorityGroup] },
        decision.actor
      );
      if (!authority.authorized) errors.push(`${phaseId} approval by '${decision.actor?.email ?? decision.actor?.login ?? decision.actor?.name ?? 'unknown'}' lacks configured authority`);
      else if (decision.authorityGroup !== authority.authorityGroup) errors.push(`${phaseId} approval authority record does not match the pinned policy`);
      if (!decision.identityAssurance) errors.push(`${phaseId} approval is missing identity-assurance metadata`);
      if (decision.selfApproval) warnings.push(`${phaseId} is self-approved by ${decision.actor?.name ?? 'unknown'}; governed agent '${decision.agent ?? 'unavailable'}' is execution context, not independent review`);
    }
    for (const artifact of phase.artifacts) {
      const current = await snapshot(path.join(root, artifact.path));
      if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) errors.push(`STALE ${phaseId} approval: ${artifact.path} changed after approval`);
    }
    const required = path.join(root, config.workItemRoot, workflow.workItem.id, phase.requiredArtifact.path);
    const text = await readFile(required, 'utf8').catch(() => '');
    if (decisions.some((item) => item.selfApproval) && !/"selfApproval": true/.test(text)) errors.push(`${phaseId} artifact does not expose its self-approval warning`);
    passes.push(`approval integrity: ${phaseId}`);
  }

  const mcpIntegrity = await verifyMcpEvidence(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  errors.push(...mcpIntegrity.errors); warnings.push(...mcpIntegrity.warnings); passes.push(...mcpIntegrity.passes);

  const designSourceIntegrity = await verifyDesignSourceLifecycle(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  errors.push(...designSourceIntegrity.errors);
  warnings.push(...designSourceIntegrity.warnings);
  passes.push(...designSourceIntegrity.passes);

  const visualCoverage = await evaluateVisualCoverage(root, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id)
  });
  if (visualCoverage.mode === 'enforce') errors.push(...visualCoverage.errors); else warnings.push(...visualCoverage.errors);
  warnings.push(...visualCoverage.warnings);
  if (visualCoverage.status === 'pass') passes.push(`visual coverage: ${visualCoverage.covered.length}/${visualCoverage.profiles.length} profiles`);
  const comparisons = await listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  for (const comparison of comparisons) {
    // Evidence that will not parse is an integrity failure, not a threshold decision, so it fails
    // the gate whatever the comparison mode says. Otherwise damaging a record is a way past it.
    if (comparison.unreadable) errors.push(`visual comparison evidence ${comparison.path} could not be read: ${comparison.error}`);
    else if (comparison.status === 'fail' && workflow.resolution?.verification?.comparison?.mode === 'enforce') errors.push(`visual comparison ${comparison.id} exceeds policy thresholds`);
    else if (comparison.status !== 'pass') warnings.push(`visual comparison ${comparison.id}: ${comparison.status}`);
  }
  if (comparisons.length) passes.push(`visual comparisons: ${comparisons.length} deterministic result(s)`);

  const specPolicy = workflow.resolution?.spec ?? config.spec ?? { mode: 'off', coverage: 'off' };
  if (specPolicy.mode !== 'off') {
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const records = terminal && workflow.resolution?.plannedClaims?.mode === 'required'
      ? await loadBoundActiveSpecRecords(root, itemDirectory, workflow, specPolicy)
      : await loadActiveSpecRecords(itemDirectory, workflow);
    const fail = (message) => (specPolicy.mode === 'enforce' ? errors : warnings).push(message);
    for (const phaseId of workflow.phaseOrder) {
      const phase = workflow.phases[phaseId];
      if (!(phase.generation > 0) || !isSpecificationDefinitionPhase(phase)) continue;
      const index = records.indexes.find((candidate) => candidate.phase === phaseId && candidate.generation === phase.generation);
      if (!index) {
        fail(`${phaseId} generation ${phase.generation} has no deterministic specification index`);
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
      if (!artifact.exists || artifact.sha256 !== index.source.sha256) fail(`${phaseId} specification index is stale for ${index.source.path}`);
      else if (drift) {
        fail(`${phaseId} specification index does not match the generation recorded in the workflow: `
          + `expected ${anchor.clauses} clause(s) for source ${String(anchor.sourceSha256).slice(0, 12)}, `
          + `found ${index.clauses.length} for ${String(index.source.sha256).slice(0, 12)}`);
      }
      else passes.push(`specification clauses: ${phaseId} generation ${phase.generation} · ${index.clauses.length}`);
    }
    if (specPolicy.coverage !== 'off') {
      const coverage = evaluateSpecCoverage(records, changedRepositoryPaths(root, {
        base: workflow.workItem.baseCommit
          ?? workflow.phases[workflow.phaseOrder[0]]?.sourceCommit
          ?? workflow.workItem.baseBranch,
        target: 'HEAD',
        pathContext: applicationPathContext(config, workflow)
      }), specPolicy, { root });
      const messages = [
        ...coverage.unimplemented.map((id) => `clause ${id} is not fully implemented`),
        ...coverage.unclaimedChangedPaths.map((file) => `changed path is not claimed by a clause: ${file}`),
        ...coverage.withdrawnButClaimed.map((id) => `withdrawn clause still has an observed claim: ${id}`),
        ...coverage.invalidEvidence.map((message) => `invalid clause evidence: ${message}`)
      ];
      if (coverage.severity === 'error') errors.push(...messages);
      else if (coverage.severity === 'warning') {
        // Record-mode coverage remains advisory during Code, but a new qualified terminal
        // conformance report cannot claim `matched` where observed clause evidence is absent.
        const terminalClauseContract = terminal && specPolicy.conformanceRows === 'qualified'
          && records.indexes.some((index) => (index.clauses ?? []).length > 0);
        if (terminalClauseContract) {
          errors.push(
            ...coverage.unimplemented.map((id) => `clause ${id} is not fully implemented`),
            ...coverage.withdrawnButClaimed.map((id) => `withdrawn clause still has an observed claim: ${id}`),
            ...coverage.invalidEvidence.map((message) => `invalid clause evidence: ${message}`)
          );
          warnings.push(...coverage.unclaimedChangedPaths.map((file) => `changed path is not claimed by a clause: ${file}`));
        } else warnings.push(...messages);
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
      const messages = [
        ...acceptance.missingPlannedTests.map((id) => `clause ${id} has no planned test`),
        ...acceptance.missingObservedTests.map((id) => `clause ${id} has no observed test result`),
        ...acceptance.failedCommands.map((id) => `allowlisted acceptance command failed: ${id}`),
        ...(acceptance.missingRun ? ['no specification acceptance run is recorded'] : []),
        ...acceptance.staleRunReasons.map((reason) => `specification acceptance is stale: ${reason}`)
      ];
      if (acceptance.complete) passes.push(`specification acceptance: ${acceptance.mode}`);
      else if (specPolicy.mode === 'enforce') errors.push(...messages);
      else warnings.push(...messages);
    }
  }

  if (config.governance?.requireAcceptanceCriteriaTags) {
    const required = new Set();
    const bound = new Set();
    for (const phase of Object.values(workflow.phases).filter(phaseRequiresCodeDelivery)) {
      for (const id of phase.deliveryEvidence?.acceptanceCriteria?.required ?? []) required.add(id);
      for (const id of phase.deliveryEvidence?.acceptanceCriteria?.tagged ?? []) bound.add(id);
    }
    for (const id of required) if (!bound.has(id)) errors.push(`AC coverage: ${id} has no module test-source binding`);
    if (required.size && [...required].every((id) => bound.has(id))) passes.push(`acceptance coverage: ${required.size} namespaced criteria mapped`);
  }

  if (terminal) {
    const configuredArchitectureGates = workflow.resolution?.architectureIntent?.blockRequiredUnfulfilledAt
      ?? config.architectureIntent?.blockRequiredUnfulfilledAt ?? [];
    for (const phaseId of configuredArchitectureGates) {
      const result = await evaluateArchitectureIntentGate(root, config, workflow, phaseId);
      errors.push(...result.errors.map((message) => `${phaseId}: ${message}`));
      warnings.push(...result.warnings.map((message) => `${phaseId}: ${message}`));
      passes.push(...result.passes);
    }
  }

  if (workflow.phases.conformance?.generation > 0) {
    const phase = workflow.phases.conformance; const reportPath = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path); const report = await readFile(reportPath, 'utf8');
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
      errors.push(...qualifiedConformanceErrors(report, qualifiedRows));
    } else {
      for (const source of traceabilitySources(workflow)) {
        const text = await readFile(path.join(workDir(root, config, workflow.workItem.id), source.requiredArtifact.path), 'utf8').catch(() => '');
        ids(text, /\b(?:AC|SPEC)-\d+\b/g).forEach((id) => expected.add(id));
      }
      for (const id of expected) if (!report.includes(id)) errors.push(`conformance report has no row for ${id}`);
    }
    for (const [phaseId, prior] of Object.entries(workflow.phases)) {
      for (const approval of prior.approvals.filter((item) => !item.invalidatedAt && item.selfApproval)) {
        const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name;
        if (!report.includes(phaseId) || (actor && !report.includes(actor))) errors.push(`conformance report does not disclose self-approval for ${phaseId} by ${actor}`);
      }
    }
    if (!/\b(matched|partial|missing|deviated|unplanned)\b/.test(report)) errors.push('conformance report has no recognized verdict');
    if (!qualifiedRows.length) {
      for (const finding of blockingConformanceVerdicts(report)) {
        errors.push(`conformance ${finding.clauseId} remains ${finding.verdict}`);
      }
    }
    if (phase.conformanceTree !== await sourceTreeHash(root, config, workflow)) errors.push('conformance report is stale: source/test tree changed after comparison');
    else passes.push(`conformance freshness: ${expected.size} traced identifiers`);
  }

  // Some workflows name their final conformance report `release`. Apply the same new, pinned
  // clause-row contract there without inventing a historical release freshness record.
  if (terminal && specPolicy.conformanceRows === 'qualified') {
    const reportPhases = workflow.phaseOrder.map((id) => workflow.phases[id]).filter((phase) =>
      phase?.id !== 'conformance' && phase?.requiredArtifact?.kind === 'conformance-report'
      && phase.generation > 0);
    if (reportPhases.length) {
      const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
      const clauseIds = [...new Set(records.indexes.flatMap((index) =>
        (index.clauses ?? []).map((clause) => clause.id)))];
      if (clauseIds.length) {
        for (const phase of reportPhases) {
          const report = await readFile(path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path), 'utf8');
          errors.push(...qualifiedConformanceErrors(report, clauseIds).map((message) => `${phase.id}: ${message}`));
        }
      }
    }
  }

  if (config.git?.publish === 'required' && terminal) {
    const remote = config.git.remote ?? 'origin';
    const publicationBranch = workflowPublicationBranch(root, workflow);
    const observation = await terminalPublicationObservation(root, remote, publicationBranch);
    if (!observation.published) errors.push(`terminal: ${observation.reason ?? `local HEAD is not published to ${remote}/${publicationBranch}`}`);
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
        if (dropped.has(phaseId)) errors.push(`terminal: phase ${phaseId} was skipped by decision${route}, so ${dropped.get(phaseId)}`);
        else passes.push(`skipped by decision: ${phaseId}${route}`);
      } else if (phase?.status !== 'approved') errors.push(`terminal: phase ${phaseId} is not approved`);
    }
    errors.push(...lapsedWitnessExceptions(workflow));
    if (workflow.pendingDecision) errors.push(`terminal: the Story is waiting for a decision: ${workflow.pendingDecision.label}`);
    if (workflow.status !== 'complete' || currentPhase(workflow)) errors.push('terminal: workflow is not complete'); else passes.push('terminal lifecycle');
  }
  return { errors, warnings, passes, findings: classifyStoryGateFailures(workflow, errors) };
}
