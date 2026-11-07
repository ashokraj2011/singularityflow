/** Native convergence drafts, receipts and provider execution. No command-layer dependency. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {assistedConvergencePrompt,assistedConvergenceRelative,buildAssistedConvergenceRecord,parseConvergenceCandidates,reusableConvergenceRecord,serializeAssistedConvergence,unknownReferences} from '../assisted-convergence.mjs';
import {unwrapProviderLineBreaks} from '../assisted-quality.mjs';
import {assertConvergenceIntegrity,convergenceProjection,findingAdjudication,renderConvergenceArtifact,serializeConvergence} from '../convergence.mjs';
import {assertConvergenceSources,assertLegacyConvergenceSourceIdentity,currentConvergenceContext} from '../convergence-context.mjs';
import {runDraftTransaction} from '../draft-unit-of-work.mjs';
import {invokeModel,resolveModelProvider} from '../model-runner.mjs';
import {mergeObservedClaimRecords,mergePlannedClaimRecords} from '../specifications.mjs';
import {loadStoryAggregate} from '../story-aggregate-read.mjs';
import {workDir} from '../story-paths.mjs';
import {preparePhase,saveStoryDraft,workflowPublicationBranch} from '../state-stores.mjs';
import {exists,posix,secureRepositoryPath,writeJson,writeText,SingularityFlowError} from '../util.mjs';
import {currentSchemaVersion,readRecord} from '../schema-migrations.mjs';
import {extractInputsBlock} from '../inputs.mjs';
import {recordSha256} from '../records.mjs';
import {resolveStoryExecutionContext} from '../story-execution-context.mjs';
import {convergenceRecordRelative,readConvergence} from './convergence-projection-read.mjs';

/**
 * The convergence subject: the implementation generation being closed, and everything bound to it.
 *
 * Gathered in one place because `[SPK:REQ-072]` asks that an iteration bind all of it — and because
 * the failure mode of scattering this is a record that binds whichever inputs the code path happened
 * to touch, which is indistinguishable from binding all of them until someone needs to re-check one.
 */
export async function convergenceSubject(root, config, workflow) {
  return currentConvergenceContext(root, config, workflow);
}

/**
 * One governed relay turn for convergence candidates. `[SPK:REQ-076]`
 *
 * `tools: none`, like the specification-quality pass. A model that could read the repository would
 * be re-deriving what reconciliation already owns, at a different altitude, with nothing recording
 * what it looked at — and `[SPK:CON-034]` would have no way to hold.
 */
async function runAssistedConvergence(root, config, workflow, subject, { facts, bindings, model = null, refresh = false }) {
  const clauses = subject.records.indexes.flatMap((index) => index.clauses ?? []);
  // Convergence can span multiple implementation intervals. A later partial record must not erase
  // exact paths, tests, or verdict evidence established by an earlier interval for the same clause.
  const plannedClaims = mergePlannedClaimRecords(subject.records.planned ?? []);
  const observedClaims = mergeObservedClaimRecords(subject.records.observed ?? [], plannedClaims);
  const prompt = assistedConvergencePrompt({
    clauses,
    observedClaims,
    changedPaths: subject.reconciliation.findings ?? [],
    facts,
    namespace: subject.policy?.namespace ?? null
  });
  const provider = resolveModelProvider(config);
  const saved = refresh ? null : await savedConvergenceCandidates(root, subject.itemRelative, {
    prompt, bindings, facts, provider: provider.provider, model: model ?? provider.model
  });
  if (saved) return saved;
  const phase = workflow.phases?.[workflow.currentPhase] ?? null;
  const execution = await resolveStoryExecutionContext(root, config, workflow, {
    agentId: phase?.defaultAgent ?? null,
    phaseId: phase?.id ?? workflow.currentPhase
  });
  const invocation = await invokeModel({
    provider: provider.provider,
    providerConfig: provider.providerConfig,
    model: model ?? provider.model,
    cwd: root,
    allowedRoots: [root],
    prompt: { text: prompt },
    channel: 'convergence-assisted',
    subject: { kind: 'convergence', id: workflow.workItem.id, iteration: bindings.iteration },
    executionContext: execution.identity,
    tools: { mode: 'none' },
    limits: { timeoutMs: 5 * 60 * 1000, outputBytes: 256 * 1024 }
  });
  const candidates = parseConvergenceCandidates(invocation.output, { unwrap: unwrapProviderLineBreaks });
  const record = buildAssistedConvergenceRecord({
    workId: workflow.workItem.id,
    bindings,
    facts,
    candidates,
    invocation,
    prompt,
    unknown: unknownReferences(candidates, { factIds: facts.map((item) => item.id), clauseIds: clauses.map((clause) => clause.id) }),
    generatedAt: invocation.completedAt ?? new Date().toISOString()
  });
  const relative = assistedConvergenceRelative(
    subject.itemRelative, bindings.iteration, record.recordSha256
  );
  await writeText(path.join(root, relative), serializeAssistedConvergence(record));
  for (const id of record.unknownReferences.factIds) console.warn(`Warning: a candidate cites deterministic fact '${id}', which this iteration does not contain.`);
  for (const id of record.unknownReferences.clauseIds) console.warn(`Warning: a candidate cites clause '${id}', which the approved specification does not contain.`);
  return { record, path: relative };
}

/**
 * The newest candidate record this iteration already has for the exact same prompt, bindings and
 * facts: asking the model again would pay for the same answer.
 */
async function savedConvergenceCandidates(root, itemRelative, match) {
  const directory = posix(path.join(itemRelative, 'context', 'convergence'));
  const prefix = `candidates-iter${match.bindings.iteration}`;
  const names = (await readdir(path.join(root, directory)).catch(() => []))
    .filter((name) => name === `${prefix}.json` || (name.startsWith(`${prefix}-`) && name.endsWith('.json')));
  const found = [];
  for (const name of names) {
    const record = reusableConvergenceRecord(await readFile(path.join(root, directory, name), 'utf8').catch(() => ''), match);
    if (record) found.push({ record, path: posix(path.join(directory, name)), reused: true });
  }
  return found.sort((a, b) => String(b.record.generatedAt).localeCompare(String(a.record.generatedAt)))[0] ?? null;
}

function convergenceLegacyArchiveRelative(itemRelative, iteration, planSha256) {
  return posix(path.join(
    itemRelative,
    'context',
    'convergence',
    'legacy',
    `iteration-${iteration}-${String(planSha256).replace(/^sha256:/, '')}.json`
  ));
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function legacyMigrationRecordSha256(record) {
  const core = structuredClone(record);
  delete core.recordSha256;
  return recordSha256(core);
}

/**
 * Build and, after an exact confirmation, preserve a v1 convergence record before replacement.
 *
 * v1 sealed its projection but not the bytes of its assisted-candidate source.  Treating a reader
 * migration as sufficient would silently promote unauthenticated model output; refusing forever
 * left an in-progress Story with no valid recovery path.  This migration therefore binds the exact
 * projection and exact legacy candidate bytes into a user-confirmed plan, archives the original
 * projection losslessly, and deliberately starts the deterministic candidate set empty.
 */
async function migrateLegacyConvergenceDraft(root, workflow, subject, legacyRelative, rawBytes, {
  enabled = false, confirmation = null, assistedRequested = false
} = {}) {
  const migrated = readRecord('convergence-record', rawBytes);
  if (migrated.storedVersion !== 1) return null;
  assertLegacyConvergenceSourceIdentity(migrated.record, {
    workId: workflow.workItem.id,
    iteration: subject.iteration
  });
  const expectedCandidate = assistedConvergenceRelative(subject.itemRelative, subject.iteration);
  const declaredCandidatePaths = migrated.record.candidateRecords ?? [];
  const candidatePaths = [...new Set(declaredCandidatePaths)].sort();
  const unsafe = candidatePaths.filter((candidate) => candidate !== expectedCandidate);
  if (unsafe.length || candidatePaths.length > 1 || candidatePaths.length !== declaredCandidatePaths.length) {
    throw new SingularityFlowError(
      'The legacy convergence record references duplicate or non-canonical candidate sources and cannot be migrated automatically. '
      + 'Preserve the Story and return it to implementation for authority review.',
      {
        code: 'CONVERGENCE_LEGACY_CANDIDATE_PATH_INVALID',
        details: { path: legacyRelative, candidatePaths, expectedCandidate }
      }
    );
  }
  const candidateBindings = [];
  for (const candidate of candidatePaths) {
    const secured = await secureRepositoryPath(root, candidate, {
      label: 'Legacy convergence candidate source', mustExist: true, type: 'file'
    });
    const bytes = await readFile(secured.absolute);
    const legacyCandidate = readRecord('assisted-convergence', bytes);
    if (legacyCandidate.storedVersion !== 1) {
      throw new SingularityFlowError(
        `Legacy convergence candidate source '${candidate}' is not a v1 record.`,
        { code: 'CONVERGENCE_LEGACY_CANDIDATE_RECORD_INVALID', details: { path: candidate } }
      );
    }
    assertLegacyConvergenceSourceIdentity(migrated.record, {
      workId: workflow.workItem.id,
      iteration: subject.iteration,
      candidate: legacyCandidate.record
    });
    candidateBindings.push({
      path: candidate,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      bytesBase64: Buffer.from(bytes).toString('base64')
    });
  }
  const planCandidateBindings = candidateBindings.map(({ path: candidate, sha256, bytes }) => ({
    path: candidate, sha256, bytes
  }));
  const plan = {
    schemaVersion: 1, // schema-transient: exact confirmation plan, persisted only inside its sealed archive
    kind: 'convergence-legacy-migration-plan',
    workId: workflow.workItem.id,
    iteration: subject.iteration,
    source: { path: legacyRelative, sha256: sha256Bytes(rawBytes), bytes: rawBytes.length },
    candidateBindings: planCandidateBindings
  };
  const planSha256 = `sha256:${recordSha256(plan)}`;
  const command = `singularity-flow story converge --work-id ${workflow.workItem.id} --migrate-legacy --confirm ${planSha256}`
    + `${assistedRequested ? ' --assisted' : ''}`;
  if (!enabled || confirmation !== planSha256) {
    throw new SingularityFlowError(
      'This convergence iteration uses a v1 assisted-candidate receipt without an immutable provenance seal. '
      + 'The original bytes will not be overwritten without an exact migration confirmation. '
      + `Review the record and run: ${command}`,
      {
        code: 'CONVERGENCE_LEGACY_MIGRATION_REQUIRED',
        details: {
          path: legacyRelative,
          storedVersion: migrated.storedVersion,
          planSha256,
          candidateBindings: planCandidateBindings,
          command
        }
      }
    );
  }
  const archiveRelative = convergenceLegacyArchiveRelative(
    subject.itemRelative, subject.iteration, planSha256
  );
  const archive = {
    schemaVersion: currentSchemaVersion('convergence-legacy-archive'),
    kind: 'convergence-legacy-archive',
    workId: workflow.workItem.id,
    iteration: subject.iteration,
    planSha256,
    source: plan.source,
    candidateBindings,
    sourceBytesBase64: Buffer.from(rawBytes).toString('base64'),
    recordSha256: null
  };
  archive.recordSha256 = legacyMigrationRecordSha256(archive);
  const archiveAbsolute = path.join(root, archiveRelative);
  if (await exists(archiveAbsolute)) {
    const existing = readRecord('convergence-legacy-archive', await readFile(archiveAbsolute)).record;
    if (existing.recordSha256 !== legacyMigrationRecordSha256(existing)
      || existing.recordSha256 !== archive.recordSha256
      || existing.planSha256 !== planSha256
      || existing.sourceBytesBase64 !== archive.sourceBytesBase64) {
      throw new SingularityFlowError(
        `Legacy convergence archive '${archiveRelative}' already exists with different bytes.`,
        { code: 'CONVERGENCE_LEGACY_ARCHIVE_CONFLICT', details: { path: archiveRelative } }
      );
    }
  } else {
    await writeJson(archiveAbsolute, archive);
  }
  return { archiveRelative, planSha256, candidateBindings: planCandidateBindings, recordSha256: archive.recordSha256 };
}

export function currentConvergenceProjectionInputs(workflow, subject) {
  return { facts: subject.facts, settlement: subject.settlement, bindings: subject.bindings };
}

function mergeManagedConvergenceArtifact(existing, projection) {
  const metadata = String(existing ?? '').match(/^<!-- singularity-flow:metadata\r?\n[\s\S]*?\r?\n-->/)?.[0] ?? null;
  const inputs = extractInputsBlock(existing ?? '');
  return [metadata, renderConvergenceArtifact(projection), inputs].filter(Boolean).join('\n\n');
}

export async function writeConvergenceProjection(root, subject, projection) {
  const stored = { ...projection, candidateSnapshot: projection.candidateSnapshot ?? [] };
  assertConvergenceIntegrity(stored, {
    workId: projection.workId,
    iteration: subject.iteration,
    currentBindings: subject.bindings,
    currentFacts: subject.facts,
    currentSettlement: subject.settlement
  });
  await assertConvergenceSources(root, stored, { itemRelative: subject.itemRelative });
  const relative = convergenceRecordRelative(subject.itemRelative, subject.iteration);
  await writeText(path.join(root, relative), serializeConvergence(stored));

  const artifactRelative = posix(path.join(subject.itemRelative, subject.phase.requiredArtifact.path));
  const securedArtifact = await secureRepositoryPath(root, artifactRelative, {
    label: 'Convergence phase artifact'
  });
  const existing = securedArtifact.exists ? await readFile(securedArtifact.absolute, 'utf8') : '';
  await writeText(securedArtifact.absolute, mergeManagedConvergenceArtifact(existing, stored));
  return { stored, relative, artifactRelative };
}

export async function withConvergenceDraft(root, config, requestedWorkId, operation, write, { authorize = null } = {}) {
  const selected = await loadStoryAggregate(root, config, requestedWorkId);
  return runDraftTransaction(root, {
    subject: {
      kind: 'story',
      id: selected.workItem.id,
      branch: workflowPublicationBranch(root, selected)
    },
    expectedRevision: selected[Symbol.for('singularity-flow.state-revision')] ?? null,
    allowedPaths: [posix(path.relative(root, workDir(root, config, selected.workItem.id)))],
    operation,
    write: async () => {
      const workflow = await loadStoryAggregate(root, config, selected.workItem.id);
      // Authority is checked on the locked state and before the convergence inputs are resolved,
      // so an identity without it is refused for that reason rather than for whatever input it
      // reaches first.
      const authority = authorize ? authorize(workflow) : null;
      const subject = await convergenceSubject(root, config, workflow);
      return write(workflow, subject, authority);
    }
  });
}

/**
 * Silent deterministic convergence service shared by CLI routing and `story converge`.
 *
 * Preparation and the canonical projection/artifact render are one rollback-capable draft unit.
 * A caller cannot accidentally stop after the generic deterministic prepare artifact and publish a
 * document that never consumed the kernel-owned convergence facts.
 */
export async function prepareDeterministicConvergence(root, config, workId = null, {
  assisted = false, model = null, refresh = false, migrateLegacy = false, legacyConfirmation = null
} = {}) {
  return withConvergenceDraft(
    root,
    config,
    workId,
    'story:converge',
    async (workflow, subject) => {
      if (workflow.currentPhase !== subject.phase.id || subject.phase.status !== 'in_progress') {
        throw new SingularityFlowError(
          `Convergence projection can be generated only while phase '${subject.phase.id}' is active and in progress.`
        );
      }
      // Always refresh managed metadata and approved-input blocks before rendering. The authored
      // body belongs to the deterministic kernel and is replaced below from the exact projection.
      await preparePhase(root, config, workflow, subject.phase.id);
      await saveStoryDraft(root, config, workflow);
      const { facts: currentFacts, settlement, bindings } = currentConvergenceProjectionInputs(workflow, subject);
      let previous;
      let legacyMigration = null;
      try {
        previous = await readConvergence(root, subject.itemRelative, subject.iteration);
      } catch (error) {
        if (error.code !== 'CONVERGENCE_CANDIDATE_RECORD_BINDING_MISSING') throw error;
        const legacyRelative = convergenceRecordRelative(subject.itemRelative, subject.iteration);
        const rawBytes = await readFile(path.join(root, legacyRelative));
        const migrated = readRecord('convergence-record', rawBytes);
        if (migrated.storedVersion !== 1) throw error;
        const migratedLegacy = await migrateLegacyConvergenceDraft(root, workflow, subject, legacyRelative, rawBytes, {
          enabled: migrateLegacy,
          confirmation: legacyConfirmation,
          assistedRequested: assisted
        });
        legacyMigration = {
          path: migratedLegacy.archiveRelative,
          recordSha256: migratedLegacy.recordSha256
        };
        // v1 candidate bytes remain preserved and are bound by the archive, but cannot authorize a
        // v2 decision. Regenerate from deterministic facts (and a fresh assisted run if requested).
        previous = null;
      }
      if (previous) {
        try {
          assertConvergenceIntegrity(previous, {
            workId: workflow.workItem.id,
            iteration: subject.iteration,
            currentBindings: bindings,
            currentFacts,
            currentSettlement: settlement
          });
          await assertConvergenceSources(root, previous, { itemRelative: subject.itemRelative });
        } catch (error) {
          if (!['CONVERGENCE_BINDINGS_STALE', 'CONVERGENCE_FACTS_STALE'].includes(error.code)) throw error;
          if (previous.findings?.length) {
            throw new SingularityFlowError(
              'Convergence inputs changed after human dispositions were recorded. The existing decisions were preserved; '
              + 'open a new implementation generation before computing a new convergence iteration.',
              { code: 'CONVERGENCE_DECISIONS_BINDINGS_STALE', cause: error }
            );
          }
          // An unadjudicated projection is a regenerable draft. Do not carry its advisory candidates
          // across changed approved inputs; recompute the exact deterministic projection below.
          previous = null;
        }
      }

      // A record from before v5 asked about every changed path. Nobody has answered a plain draft, so it
      // is rebuilt with what the plan settles. Once a person has answered, or an assisted pass is bound
      // to its facts, it keeps its questions: no answer or candidate may change what it was about.
      const keepsEveryQuestion = previous?.settledByPlan === undefined
        && Boolean(previous?.findings?.length || previous?.candidates?.length);
      const facts = keepsEveryQuestion ? previous.facts : currentFacts;
      const assistedResult = assisted
        ? await runAssistedConvergence(root, config, workflow, subject, {
          facts, bindings, model, refresh
        })
        : null;
      const candidates = assistedResult?.record.candidates ?? previous?.candidateSnapshot ?? [];
      const projection = {
        ...convergenceProjection({
          workId: workflow.workItem.id,
          bindings,
          facts,
          candidates,
          // One authoritative complete snapshot per iteration. An assisted rerun replaces the
          // selected source rather than requiring every historical candidate record to equal the
          // latest snapshot.
          candidateRecords: assistedResult ? [assistedResult.path] : (previous?.candidateRecords ?? []),
          candidateRecordBindings: assistedResult
            ? [{ path: assistedResult.path, sha256: assistedResult.record.recordSha256 }]
            : (previous?.candidateRecordBindings ?? []),
          legacyMigration: legacyMigration ?? previous?.legacyMigration ?? null,
          // Carried forward only after the exact current binding and complete candidate source have
          // been verified under the Story mutation lock.
          adjudications: previous?.findings?.map(findingAdjudication) ?? [],
          settledByPlan: keepsEveryQuestion ? null : settlement.settled
        }),
        candidateSnapshot: candidates
      };
      const written = await writeConvergenceProjection(root, subject, projection);
      return {
        workflow,
        subject,
        facts,
        bindings,
        assisted: assistedResult,
        projection,
        path: written.relative,
        artifactPath: written.artifactRelative
      };
    }
  );
}
