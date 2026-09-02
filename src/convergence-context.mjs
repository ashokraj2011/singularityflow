import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  assertConvergenceCandidateSource, assertConvergencePublishable, convergenceBindings,
  convergenceFacts, decodeConvergenceRecord
} from './convergence.mjs';
import { authoredArtifactFingerprint, authoredArtifactText, requiredArtifactRepoPath } from './publication-preflight.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import {
  evaluateSpecAcceptance, loadBoundActiveSpecRecords
} from './specifications.mjs';
import {
  applicationChangeSetProjection, applicationPathContext, assertWorkReconciliationIntegrity
} from './work-intervals.mjs';
import { posix, run, secureRepositoryPath, SingularityFlowError, snapshot } from './util.mjs';

function sameDigest(left, right) {
  return String(left ?? '').replace(/^sha256:/, '') === String(right ?? '').replace(/^sha256:/, '');
}

/**
 * Bind preserved v1 projection/candidate bytes to the Story iteration that is migrating them.
 * Historical candidate receipts lack today's provenance hash, so they can be archived for audit
 * but never granted current authority. Their subject and deterministic input identity must still
 * be exact; otherwise another Story's valid old bytes could be relabelled during migration.
 */
export function assertLegacyConvergenceSourceIdentity(projection, {
  workId, iteration, candidate = null
} = {}) {
  if (projection?.resultType !== 'convergence'
      || projection.workId !== workId
      || Number(projection.iteration) !== Number(iteration)
      || Number(projection.bindings?.iteration) !== Number(iteration)) {
    throw new SingularityFlowError(
      'Legacy convergence projection does not belong to the current Story iteration.',
      { code: 'CONVERGENCE_LEGACY_SUBJECT_MISMATCH', details: { workId, iteration } }
    );
  }
  if (candidate != null) {
    const expectedDeterministic = {
      reconciliationSha256: projection.bindings?.reconciliation?.sha256 ?? null,
      sourceTargetCommit: projection.bindings?.sourceTargetCommit ?? null,
      clauseIndexSha256: projection.bindings?.clauseIndexSha256 ?? [],
      factIds: (projection.facts ?? []).map((item) => item.id)
    };
    if (candidate?.resultType !== 'convergence-candidates'
        || candidate.workId !== workId
        || Number(candidate.iteration) !== Number(iteration)
        || canonicalJson(candidate.deterministic ?? null) !== canonicalJson(expectedDeterministic)
        || canonicalJson(candidate.candidates ?? []) !== canonicalJson(projection.candidateSnapshot ?? [])) {
      throw new SingularityFlowError(
        'Legacy convergence candidate receipt does not belong to the preserved Story iteration and inputs.',
        { code: 'CONVERGENCE_LEGACY_CANDIDATE_SUBJECT_MISMATCH', details: { workId, iteration } }
      );
    }
  }
  return projection;
}

function assertCommittedPath(root, relative, label) {
  const current = run('git', ['hash-object', '--', relative], { cwd: root, allowFailure: true });
  const committed = run('git', ['rev-parse', '--verify', `HEAD:${relative}`], {
    cwd: root, allowFailure: true
  });
  if (current.status !== 0 || committed.status !== 0
      || current.stdout.trim() !== committed.stdout.trim()) {
    throw new SingularityFlowError(
      `${label} differs from the exact approved bytes in Git. Restore or publish that upstream phase before convergence.`,
      { code: 'CONVERGENCE_UPSTREAM_ARTIFACT_STALE', details: { path: relative } }
    );
  }
}

async function verifiedUpstreamArtifacts(root, config, workflow) {
  const convergenceIndex = workflow.phaseOrder.indexOf('convergence');
  const bindings = [];
  for (const phaseId of workflow.phaseOrder.slice(0, Math.max(0, convergenceIndex))) {
    const phase = workflow.phases?.[phaseId];
    if (!phase?.requiredArtifact?.path || !(phase.generation > 0)) continue;
    const relative = requiredArtifactRepoPath(config, workflow, phase);
    const secured = await secureRepositoryPath(root, relative, {
      label: `Approved ${phase.id} artifact`, mustExist: true, type: 'file'
    });
    const current = await snapshot(secured.absolute);
    const registered = (phase.artifacts ?? []).find((artifact) => artifact.path === secured.relative);
    if (!registered || registered.status !== 'approved'
        || !sameDigest(registered.sha256, current.sha256)
        || Number(registered.size) !== Number(current.size)) {
      throw new SingularityFlowError(
        `Approved upstream artifact '${secured.relative}' changed after ${phase.id} was approved.`,
        {
          code: 'CONVERGENCE_UPSTREAM_ARTIFACT_STALE',
          details: { phase: phase.id, path: secured.relative }
        }
      );
    }
    assertCommittedPath(root, secured.relative, `Approved ${phase.id} artifact`);
    bindings.push({
      phase: phase.id,
      generation: phase.generation,
      path: secured.relative,
      sha256: current.sha256,
      size: current.size
    });
  }
  return bindings;
}

export function exactConvergencePhaseArtifactRef(phase, upstreamArtifacts = []) {
  if (!phase) return null;
  const artifact = upstreamArtifacts.find((entry) => entry.phase === phase.id
    && Number(entry.generation) === Number(phase.generation));
  return { generation: phase.generation ?? null, sha256: artifact?.sha256 ?? null };
}

async function assertReconciliationTargetCurrent(root, config, workflow, reconciliation) {
  const targetHead = reconciliation?.target?.head;
  if (!targetHead) {
    throw new SingularityFlowError(
      'Implementation reconciliation does not identify the exact reviewed repository target.',
      { code: 'WORK_RECONCILIATION_BINDING_MISMATCH' }
    );
  }
  const current = await buildRepositoryChangeSet(root, {
    baseCommit: targetHead,
    subject: {
      kind: 'convergence-reconciliation-target',
      workId: workflow.workItem.id,
      phase: reconciliation.phaseId,
      generation: reconciliation.generation,
      reconciliationSha256: reconciliation.reconciliationSha256
    }
  });
  const application = applicationChangeSetProjection(
    current, applicationPathContext(config, workflow)
  );
  if (application.entries.length) {
    const changedPaths = [...new Set(application.entries.flatMap((entry) => [
      entry.oldPath, entry.newPath
    ]).filter(Boolean))].sort();
    throw new SingularityFlowError(
      'Application source or test paths changed after the implementation reconciliation. '
      + 'Return to implementation, reconcile and publish the new delivery before convergence.',
      {
        code: 'WORK_RECONCILIATION_TARGET_DRIFT',
        details: {
          reconciliationSha256: reconciliation.reconciliationSha256,
          targetHead,
          applicationChangeSetSha256: application.digest,
          changedPaths: changedPaths.slice(0, 25),
          omittedChangedPaths: Math.max(0, changedPaths.length - 25)
        }
      }
    );
  }
  return {
    reconciliationSha256: reconciliation.reconciliationSha256,
    targetHead,
    applicationChangeSetSha256: application.digest
  };
}

/**
 * Resolve the exact current inputs for one convergence iteration.
 *
 * Generation, adjudication, advancement, and publication all consume this function. Having one
 * resolver is what prevents publication from validating a self-consistent but stale projection
 * after the specification, claims, acceptance evidence, or reconciliation has moved.
 */
export async function currentConvergenceContext(root, config, workflow) {
  const phase = workflow.phases.convergence;
  if (!phase) throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no convergence phase.`);
  const implementation = workflow.phases.implementation;
  if (!implementation) throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no implementation phase to converge.`);
  const reconciliationRef = implementation.workIntervalReconciliation;
  if (!reconciliationRef?.path) {
    throw new SingularityFlowError(
      'Convergence operates on the reconciliation record for the implementation generation, and none exists yet. '
      + 'Run singularity-flow submit implementation first.'
    );
  }
  const itemDirectory = path.join(
    root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id
  );
  const itemRelative = posix(path.relative(root, itemDirectory));
  const expectedReconciliationPath = posix(path.join(
    itemRelative, 'context', 'work-intervals', 'reconciliations',
    `${reconciliationRef.reconciliationSha256}.json`
  ));
  if (posix(reconciliationRef.path) !== expectedReconciliationPath) {
    throw new SingularityFlowError(
      `Implementation reconciliation path '${reconciliationRef.path}' is outside its exact Story binding.`,
      {
        code: 'WORK_RECONCILIATION_BINDING_MISMATCH',
        details: { expectedPath: expectedReconciliationPath, currentPath: reconciliationRef.path }
      }
    );
  }
  const reconciliationPath = await secureRepositoryPath(root, reconciliationRef.path, {
    label: 'Implementation reconciliation', mustExist: true, type: 'file'
  });
  assertCommittedPath(root, reconciliationPath.relative, 'Implementation reconciliation');
  const reconciliation = readRecord(
    'work-reconciliation', await readFile(reconciliationPath.absolute)
  ).record;
  reconciliation.path = reconciliationRef.path;
  const policy = workflow.resolution?.spec ?? config.spec;
  assertWorkReconciliationIntegrity(reconciliation, {
    reference: reconciliationRef,
    workId: workflow.workItem.id,
    phaseId: implementation.id,
    generation: implementation.generation
  });
  const reconciliationTarget = await assertReconciliationTargetCurrent(
    root, config, workflow, reconciliation
  );
  // Required claim-map workflows admit planned/observed evidence only through the workflow's
  // hash-bound pointers. A stray current-generation JSON file must never alter convergence facts.
  const records = await loadBoundActiveSpecRecords(
    root, itemDirectory, workflow, policy, { requireCommitted: true }
  );
  const upstreamArtifacts = await verifiedUpstreamArtifacts(root, config, workflow);
  const iteration = Math.max(1, Number(implementation.generation ?? 1));
  const acceptance = evaluateSpecAcceptance(records, policy, {
    workId: workflow.workItem.id,
    phase: implementation.id,
    generation: implementation.generation
  });
  const facts = convergenceFacts({
    reconciliation,
    indexes: records.indexes,
    planned: records.planned,
    observed: records.observed,
    acceptance,
    amendedClauses: [...new Set((workflow.workIntervals?.current?.amendments ?? [])
      .flatMap((entry) => entry.clauses ?? []))]
  });
  const bindings = convergenceBindings({
    iteration,
    configurationSha256: workflow.resolution?.configSha256 ?? null,
    configurationRevision: workflow.resolution?.configurationSource?.commit ?? null,
    constitutionSha256: workflow.resolution?.constitutionPin?.indexSha256
      ?? workflow.resolution?.constitutionPin?.fileSha256
      ?? null,
    specification: exactConvergencePhaseArtifactRef(workflow.phases.specification, upstreamArtifacts),
    planning: exactConvergencePhaseArtifactRef(workflow.phases.planning, upstreamArtifacts),
    indexes: records.indexes,
    reconciliation,
    planned: records.planned,
    observed: records.observed,
    evidence: records.acceptance
  });
  return {
    phase,
    implementation,
    itemDirectory,
    itemRelative,
    reconciliation,
    reconciliationTarget,
    records,
    upstreamArtifacts,
    policy,
    acceptance,
    iteration,
    facts,
    bindings
  };
}

/** Verify every complete assisted snapshot against its exact repository-owned source record. */
export async function assertConvergenceSources(root, projection, { itemRelative = null } = {}) {
  const records = projection.candidateRecords ?? [];
  if ((projection.candidateSnapshot ?? []).length && !records.length) {
    throw new SingularityFlowError(
      'Convergence contains assisted candidates but does not identify their complete source record.',
      { code: 'CONVERGENCE_CANDIDATE_RECORD_MISSING' }
    );
  }
  const verified = [];
  const sourceBindings = projection.candidateRecordBindings ?? [];
  const expectedPaths = itemRelative == null ? null : sourceBindings.map((binding) => posix(path.join(
    itemRelative, 'context', 'convergence',
    `candidates-iter${projection.iteration}-${String(binding.sha256).slice(0, 16)}.json`
  )));
  const legacyPath = itemRelative == null ? null : posix(path.join(
    itemRelative, 'context', 'convergence', `candidates-iter${projection.iteration}.json`
  ));
  const invalidPath = records.some((relative, index) => {
    const normalized = posix(relative);
    return normalized !== expectedPaths?.[index] && normalized !== legacyPath;
  });
  if (expectedPaths && (records.length > 1 || invalidPath)) {
    throw new SingularityFlowError(
      'Convergence candidate provenance must be the exact source record for this Story iteration.',
      {
        code: 'CONVERGENCE_CANDIDATE_RECORD_PATH_MISMATCH',
        details: { expectedPaths, legacyPath, currentPaths: records.map(posix) }
      }
    );
  }
  for (const relative of records) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Assisted convergence candidate record', mustExist: true, type: 'file'
    });
    let source;
    try { source = readRecord('assisted-convergence', await readFile(secured.absolute)).record; }
    catch (error) {
      throw new SingularityFlowError(
        `Convergence candidate record '${relative}' is corrupt: ${error.message}`,
        { code: 'CONVERGENCE_CANDIDATE_RECORD_CORRUPT', details: { path: relative }, cause: error }
      );
    }
    assertConvergenceCandidateSource(source, projection, { path: relative });
    verified.push({ path: posix(relative), recordSha256: source.recordSha256, contentSha256: recordSha256(source) });
  }
  if (projection.legacyMigration) {
    if (itemRelative == null) {
      throw new SingularityFlowError(
        'Convergence legacy migration cannot be verified without its canonical Story directory.',
        { code: 'CONVERGENCE_LEGACY_ARCHIVE_PATH_INVALID' }
      );
    }
    const binding = projection.legacyMigration;
    const archivePath = await secureRepositoryPath(root, binding.path, {
      label: 'Legacy convergence archive', mustExist: true, type: 'file'
    });
    let archive;
    try { archive = readRecord('convergence-legacy-archive', await readFile(archivePath.absolute)).record; }
    catch (error) {
      throw new SingularityFlowError(
        `Legacy convergence archive '${binding.path}' is corrupt: ${error.message}`,
        { code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT', details: { path: binding.path }, cause: error }
      );
    }
    const archiveCore = structuredClone(archive);
    delete archiveCore.recordSha256;
    const computedRecordSha256 = recordSha256(archiveCore);
    if (!Array.isArray(archive.candidateBindings)) {
      throw new SingularityFlowError('Legacy convergence archive has no canonical candidate binding list.', {
        code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT', details: { path: binding.path }
      });
    }
    const planCandidateBindings = archive.candidateBindings.map((candidate) => ({
      path: candidate?.path,
      sha256: candidate?.sha256,
      bytes: candidate?.bytes
    }));
    const confirmationPlan = {
      schemaVersion: 1, // schema-transient: reconstructed exact confirmation plan
      kind: 'convergence-legacy-migration-plan',
      workId: archive.workId,
      iteration: archive.iteration,
      source: {
        path: archive.source?.path,
        sha256: archive.source?.sha256,
        bytes: archive.source?.bytes
      },
      candidateBindings: planCandidateBindings
    };
    const computedPlanSha256 = `sha256:${recordSha256(confirmationPlan)}`;
    const expectedPath = posix(path.join(
      itemRelative,
      'context',
      'convergence',
      'legacy',
      `iteration-${projection.iteration}-${computedPlanSha256.replace(/^sha256:/, '')}.json`
    ));
    if (archive.kind !== 'convergence-legacy-archive'
        || archive.workId !== projection.workId
        || Number(archive.iteration) !== Number(projection.iteration)
        || archive.planSha256 !== computedPlanSha256
        || binding.path !== expectedPath
        || archive.recordSha256 !== computedRecordSha256
        || binding.recordSha256 !== archive.recordSha256) {
      throw new SingularityFlowError(
        `Legacy convergence archive '${binding.path}' does not match its sealed Story projection binding.`,
        {
          code: 'CONVERGENCE_LEGACY_ARCHIVE_BINDING_MISMATCH',
          details: {
            path: binding.path,
            expectedPath,
            expectedSha256: binding.recordSha256,
            currentSha256: archive.recordSha256 ?? null
          }
        }
      );
    }
    const exactBytes = (encoded, description) => {
      if (typeof encoded !== 'string' || !encoded) {
        throw new SingularityFlowError(`${description} has no preserved bytes.`, {
          code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT'
        });
      }
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded) {
        throw new SingularityFlowError(`${description} has non-canonical preserved bytes.`, {
          code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT'
        });
      }
      return decoded;
    };
    const sourceBytes = exactBytes(archive.sourceBytesBase64, 'Legacy convergence projection');
    const sourceSha256 = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`;
    if (archive.source?.path !== posix(path.join(
      itemRelative, 'context', 'convergence', `iteration-${projection.iteration}.json`
    )) || archive.source?.bytes !== sourceBytes.length || archive.source?.sha256 !== sourceSha256) {
      throw new SingularityFlowError('Legacy convergence archive does not preserve its exact source projection.', {
        code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT', details: { path: binding.path }
      });
    }
    // Running the registry migration validates the original v1 convergence hash without granting
    // its unauthenticated candidates current authority.
    const original = readRecord('convergence-record', sourceBytes);
    if (original.storedVersion !== 1) {
      throw new SingularityFlowError('Legacy convergence archive does not contain a v1 source record.', {
        code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT', details: { path: binding.path }
      });
    }
    assertLegacyConvergenceSourceIdentity(original.record, {
      workId: projection.workId,
      iteration: projection.iteration
    });
    const originalCandidatePaths = original.record.candidateRecords ?? [];
    const archivedCandidatePaths = planCandidateBindings.map((candidate) => candidate.path);
    if (originalCandidatePaths.length !== archivedCandidatePaths.length
        || originalCandidatePaths.some((candidate, index) => candidate !== archivedCandidatePaths[index])) {
      throw new SingularityFlowError(
        'Legacy convergence archive candidate bindings do not exactly match its v1 source projection.',
        { code: 'CONVERGENCE_LEGACY_ARCHIVE_BINDING_MISMATCH', details: { path: binding.path } }
      );
    }
    for (const candidate of archive.candidateBindings ?? []) {
      const candidateBytes = exactBytes(candidate.bytesBase64, `Legacy candidate '${candidate.path ?? 'unknown'}'`);
      const candidateSha256 = `sha256:${createHash('sha256').update(candidateBytes).digest('hex')}`;
      const canonicalCandidatePath = posix(path.join(
        itemRelative, 'context', 'convergence', `candidates-iter${projection.iteration}.json`
      ));
      if (candidate.path !== canonicalCandidatePath || candidate.bytes !== candidateBytes.length
          || candidate.sha256 !== candidateSha256) {
        throw new SingularityFlowError('Legacy convergence archive contains an invalid candidate-byte binding.', {
          code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT', details: { path: binding.path }
        });
      }
      const candidateRecord = readRecord('assisted-convergence', candidateBytes);
      if (candidateRecord.storedVersion !== 1) {
        throw new SingularityFlowError('Legacy convergence archive candidate is not a v1 record.', {
          code: 'CONVERGENCE_LEGACY_ARCHIVE_CORRUPT', details: { path: binding.path }
        });
      }
      assertLegacyConvergenceSourceIdentity(original.record, {
        workId: projection.workId,
        iteration: projection.iteration,
        candidate: candidateRecord.record
      });
    }
    verified.push({
      kind: 'legacy-archive', path: binding.path,
      recordSha256: archive.recordSha256,
      contentSha256: recordSha256(archive)
    });
  }
  return verified.sort((left, right) => left.path.localeCompare(right.path));
}

function convergenceProjectionRelative(current) {
  return posix(path.join(
    current.itemRelative, 'context', 'convergence', `iteration-${current.iteration}.json`
  ));
}

/** Load and verify the current projection without requiring its review to be complete. */
export async function loadVerifiedConvergenceProjection(root, config, workflow) {
  const current = await currentConvergenceContext(root, config, workflow);
  const projectionRelative = convergenceProjectionRelative(current);
  let projectionPath;
  try {
    projectionPath = await secureRepositoryPath(root, projectionRelative, {
      label: 'Convergence projection', mustExist: true, type: 'file'
    });
  } catch (error) {
    throw new SingularityFlowError(
      `Convergence iteration ${current.iteration} has no valid deterministic projection. `
      + 'Run singularity-flow prepare convergence before continuing.',
      {
        code: 'CONVERGENCE_PROJECTION_REQUIRED',
        details: { iteration: current.iteration, path: projectionRelative }, cause: error
      }
    );
  }
  const projection = decodeConvergenceRecord(await readFile(projectionPath.absolute), {
    workId: workflow.workItem.id,
    iteration: current.iteration,
    currentBindings: current.bindings,
    currentFacts: current.facts
  });
  const candidateSources = await assertConvergenceSources(root, projection, {
    itemRelative: current.itemRelative
  });
  const snapshotSha256 = `sha256:${recordSha256({
    workId: workflow.workItem.id,
    iteration: current.iteration,
    projection: recordSha256(projection),
    projectionSha256: projection.convergenceSha256,
    bindings: current.bindings,
    facts: current.facts,
    reconciliation: recordSha256(current.reconciliation),
    reconciliationTarget: current.reconciliationTarget,
    activeSpecificationRecords: recordSha256(current.records),
    upstreamArtifacts: current.upstreamArtifacts,
    candidateSources
  })}`;
  return { projection, current, projectionRelative, candidateSources, snapshotSha256 };
}

/**
 * Validate the complete deterministic convergence publication boundary and return its stable
 * snapshot. CLI preflight, the state transition, recovery, and the pre/post-stage worktree guard
 * all call this same service, preventing a source from changing after one surface approved it.
 */
export async function assertConvergencePublicationReady(root, config, workflow, phase = null) {
  const selected = phase ?? workflow.phases?.convergence;
  if (selected?.id !== 'convergence') {
    throw new SingularityFlowError('Deterministic convergence publication requires the convergence phase.', {
      code: 'CONVERGENCE_PHASE_REQUIRED'
    });
  }
  const verified = await loadVerifiedConvergenceProjection(root, config, workflow);
  const { current, projection, projectionRelative, candidateSources } = verified;
  try {
    const artifactRelative = requiredArtifactRepoPath(config, workflow, selected);
    const artifactPath = await secureRepositoryPath(root, artifactRelative, {
      label: 'Convergence phase artifact', mustExist: true, type: 'file'
    });
    const extension = path.extname(artifactRelative).toLocaleLowerCase('en-US');
    const allowedExtensions = selected.requiredArtifact?.allowedExtensions
      ?.map((value) => String(value).toLocaleLowerCase('en-US')) ?? [];
    if (allowedExtensions.length && !allowedExtensions.includes(extension)) {
      throw new SingularityFlowError(
        `The convergence artifact extension '${extension || '(none)'}' is not allowed.`,
        { code: 'CONVERGENCE_ARTIFACT_TYPE_INVALID' }
      );
    }
    const mediaType = ['.md', '.markdown'].includes(extension) ? 'text/markdown'
      : extension === '.txt' ? 'text/plain' : 'application/octet-stream';
    if (selected.requiredArtifact?.allowedMediaTypes?.length
        && !selected.requiredArtifact.allowedMediaTypes.includes(mediaType)) {
      throw new SingularityFlowError(
        `The convergence artifact media type '${mediaType}' is not allowed.`,
        { code: 'CONVERGENCE_ARTIFACT_TYPE_INVALID' }
      );
    }
    const artifact = await readFile(artifactPath.absolute, 'utf8');
    const authored = authoredArtifactText(artifact);
    const authoredBytes = Buffer.byteLength(authored);
    const minimum = selected.requiredArtifact?.minimumBytes ?? 1;
    const maximum = selected.requiredArtifact?.maximumBytes ?? Number.MAX_SAFE_INTEGER;
    if (authoredBytes < minimum || authoredBytes > maximum) {
      throw new SingularityFlowError(
        `The canonical convergence artifact has ${authoredBytes} authored bytes; configured bounds are ${minimum}..${maximum}.`,
        { code: 'CONVERGENCE_ARTIFACT_SIZE_INVALID', details: { authoredBytes, minimum, maximum } }
      );
    }
    assertConvergencePublishable(projection, authored);
    const snapshotSha256 = `sha256:${recordSha256({
      workId: workflow.workItem.id,
      iteration: current.iteration,
      verifiedProjectionSnapshotSha256: verified.snapshotSha256,
      artifactSha256: authoredArtifactFingerprint(artifact),
      bindings: current.bindings,
      facts: current.facts,
      reconciliation: recordSha256(current.reconciliation),
      reconciliationTarget: current.reconciliationTarget,
      activeSpecificationRecords: recordSha256(current.records),
      upstreamArtifacts: current.upstreamArtifacts,
      candidateSources
    })}`;
    return { projection, current, projectionRelative, artifactRelative, candidateSources, snapshotSha256 };
  } catch (error) {
    if (String(error?.code ?? '').startsWith('CONVERGENCE_')
        || String(error?.code ?? '').startsWith('WORK_RECONCILIATION_')
        || String(error?.code ?? '').startsWith('SPECIFICATION_')) throw error;
    throw new SingularityFlowError(
      `Convergence iteration ${current.iteration} cannot be published because its deterministic evidence is invalid: ${error.message}`,
      {
        code: 'CONVERGENCE_PROJECTION_INVALID',
        details: { iteration: current.iteration, path: projectionRelative }, cause: error
      }
    );
  }
}
