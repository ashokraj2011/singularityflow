/**
 * Exact generation-publication identity.
 *
 * Commit subjects are useful search text, never authority. New publications carry an immutable,
 * content-addressed record inside the commit and bind that record to the transaction/event trailers
 * of the containing commit. Legacy commits are accepted only when their already-committed workflow,
 * event projection, generation-start receipt, and transaction trailers all verify uniquely.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { verifyRepositoryChangeSetIntegrity } from './repository-change-set.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { posix, run, SingularityFlowError, writeJson } from './util.mjs';

const SHA = /^[0-9a-f]{40,64}$/i;

function sha256Record(value) {
  return `sha256:${recordSha256(value)}`;
}

function generationStartSha256(record) {
  const { receiptSha256: _receiptSha256, ...content } = record ?? {};
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`;
}

function contextRootFromIntent(intent) {
  const relative = posix(String(intent?.path ?? ''));
  if (!relative.endsWith('.json') || !relative.includes('/context/generation-start/')) return null;
  return path.posix.dirname(path.posix.dirname(relative));
}

function workDirectoryFromPhase(phase) {
  const contextRoot = contextRootFromIntent(phase?.generationIntent);
  if (contextRoot) return path.posix.dirname(contextRoot);
  const artifactPath = (phase?.artifacts ?? []).map((entry) => posix(entry.path ?? ''))
    .find((candidate) => candidate.includes('/artifacts/'));
  return artifactPath ? artifactPath.slice(0, artifactPath.indexOf('/artifacts/')) : null;
}

export function generationPublicationRelative(phase, generation = phase?.generation, workDirectory = null) {
  const itemRoot = posix(workDirectory ?? workDirectoryFromPhase(phase) ?? '');
  if (!itemRoot || !Number.isInteger(Number(generation)) || Number(generation) < 1) return null;
  return `${itemRoot}/context/generation-publications/${phase.id}-gen${Number(generation)}.json`;
}

function workflowRelative(recordPath) {
  return `${path.posix.dirname(path.posix.dirname(path.posix.dirname(recordPath)))}/workflow.json`;
}

function readAt(root, commit, relative, family) {
  const shown = run('git', ['show', `${commit}:${relative}`], { cwd: root, allowFailure: true });
  if (shown.status !== 0) throw new Error(`${relative} is not committed at ${commit.slice(0, 12)}`);
  return readRecord(family, shown.stdout).record;
}

function commitIdentity(root, commit) {
  const verified = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: root, allowFailure: true });
  if (verified.status !== 0) return null;
  const exact = verified.stdout.trim();
  const message = run('git', ['show', '-s', '--format=%B', exact], { cwd: root }).stdout;
  const trailer = (name) => {
    const values = [...message.matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'gmi'))];
    return values.length === 1 ? values[0][1] : null;
  };
  return {
    commit: exact,
    tree: run('git', ['rev-parse', `${exact}^{tree}`], { cwd: root }).stdout.trim(),
    parents: run('git', ['show', '-s', '--format=%P', exact], { cwd: root }).stdout.trim().split(/\s+/).filter(Boolean),
    transactionId: trailer('Singularity-Flow-Transaction'),
    eventSha256: trailer('Singularity-Flow-Event-SHA256')
  };
}

function verifiedProjection(workflow, record, eventSha256) {
  const projection = (workflow.publicationProjections ?? []).find((entry) =>
    entry.event?.eventId === record.eventId
      && entry.event?.type === 'artifact-generated'
      && entry.event?.phaseId === record.phase
      && Number(entry.event?.generation) === Number(record.generation));
  if (!projection || sha256Record(projection.event) !== eventSha256) return null;
  return projection.event;
}

function verifyCommittedEvidence(root, commit, {
  record = null,
  recordPath,
  workId,
  phaseId,
  generation,
  legacy = false
}) {
  try {
    const identity = commitIdentity(root, commit);
    if (!identity?.transactionId || !identity.eventSha256) return { valid: false, reason: 'governed transaction trailers are missing' };
    if (record) {
      const { recordSha256: claimed, ...core } = record;
      if (claimed !== sha256Record(core)) return { valid: false, reason: 'publication record hash differs' };
      if (record.kind !== 'generation-publication'
          || record.workId !== workId || record.phase !== phaseId
          || Number(record.generation) !== Number(generation)
          || record.transactionId !== identity.transactionId
          || record.eventSha256 !== identity.eventSha256
          || record.commitBinding?.method !== 'containing-governed-transaction'
          || record.commitBinding?.commit !== '$self'
          || record.commitBinding?.tree !== '$self'
          || record.commitBinding?.parent !== identity.parents[0]
          || identity.parents.length !== 1) return { valid: false, reason: 'publication identity differs from its containing commit' };
    }
    const evidencePath = recordPath ?? generationPublicationRelative({
      id: phaseId,
      generationIntent: { path: record?.generationStart?.path }
    }, generation);
    const aggregatePath = workflowRelative(evidencePath);
    const workflow = readAt(root, commit, aggregatePath, 'story-workflow');
    if (workflow.workItem?.id !== workId) return { valid: false, reason: 'committed workflow identity differs' };
    const phase = workflow.phases?.[phaseId];
    const recordedPublication = (phase?.generationPublications ?? [])
      .find((entry) => Number(entry.generation) === Number(generation));
    const intentPublication = Number(phase?.generationIntent?.generation) === Number(generation)
      ? phase.generationIntent?.publication ?? null : null;
    const publication = recordedPublication ?? intentPublication;
    if (!phase || Number(phase.generation) < Number(generation)
        || (record && Number(recordedPublication?.generation) !== Number(generation))) {
      return { valid: false, reason: 'committed generation state differs' };
    }
    const eventId = record?.eventId
      ?? (workflow.publicationProjections ?? []).find((entry) =>
        entry.event?.type === 'artifact-generated'
          && entry.event?.phaseId === phaseId
          && Number(entry.event?.generation) === Number(generation))?.event?.eventId;
    const projectionRecord = record ?? { eventId, phase: phaseId, generation };
    const event = verifiedProjection(workflow, projectionRecord, identity.eventSha256);
    if (!event) return { valid: false, reason: 'committed lifecycle event does not match its trailer' };

    const startPath = record?.generationStart?.path ?? (legacy ? phase.generationIntent?.path ?? null : null);
    let start = null;
    if (startPath) {
      if (Number(phase.generationIntent?.generation) !== Number(generation)
          || phase.generationIntent?.status !== 'consumed') {
        return { valid: false, reason: 'committed generation intent differs' };
      }
      start = readAt(root, commit, startPath, 'generation-start');
      const startSha = generationStartSha256(start);
      const expectedStartSha = record?.generationStart?.sha256 ?? phase.generationIntent?.receiptSha256;
      if (start.workId !== workId || start.phase !== phaseId || Number(start.generation) !== Number(generation)
          || start.generationIntentId !== phase.generationIntent.id
          || start.receiptSha256 !== startSha || expectedStartSha !== startSha
          || event.payload?.generationStartSha256 !== startSha) {
        return { valid: false, reason: 'generation-start evidence differs' };
      }
    }
    if (record) {
      if (record.generationIntentId !== (start?.generationIntentId ?? null)
          || record.resultDigest !== publication.resultDigest
          || record.changeSet?.digest !== publication.changeSetDigest
          || (start && (record.baseline?.commit !== start.baseline?.commit
            || record.baseline?.tree !== start.baseline?.tree))
          || publication.record?.path !== recordPath
          || publication.record?.sha256 !== record.recordSha256) {
        return { valid: false, reason: 'publication result binding differs' };
      }
      if (!start) {
        const parentTree = run('git', ['rev-parse', `${identity.parents[0]}^{tree}`], {
          cwd: root, allowFailure: true
        });
        if (record.baseline?.commit !== identity.parents[0]
            || parentTree.status !== 0
            || record.baseline?.tree !== parentTree.stdout.trim()) {
          return { valid: false, reason: 'publication baseline differs from the exact parent' };
        }
      }
    }
    const changePath = record?.changeSet?.path ?? phase.deliveryEvidence?.changeSetPath;
    const changeDigest = record?.changeSet?.digest ?? publication?.changeSetDigest;
    if (changePath || changeDigest) {
      const changeSet = readAt(root, commit, changePath, 'repository-change-set');
      if (!verifyRepositoryChangeSetIntegrity(changeSet).valid || changeSet.digest !== changeDigest) {
        return { valid: false, reason: 'repository change-set evidence differs' };
      }
    }
    if (legacy) {
      const parent = `${commit}^`;
      const changed = run('git', ['diff', '--quiet', parent, commit, '--', aggregatePath], {
        cwd: root, allowFailure: true
      });
      if (changed.status !== 1) return { valid: false, reason: 'legacy candidate did not publish the workflow state' };
    }
    return { valid: true, commit, tree: identity.tree, parent: identity.parents[0], transactionId: identity.transactionId };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

export async function persistGenerationPublicationRecord(root, workflow, phase, {
  publicationEvent,
  transactionId,
  expectedHead,
  workDirectory = null
} = {}) {
  const publication = (phase.generationPublications ?? [])
    .find((entry) => Number(entry.generation) === Number(phase.generation));
  const recordPath = generationPublicationRelative(phase, phase.generation, workDirectory);
  if (!publication || !recordPath || !publicationEvent || !transactionId || !SHA.test(expectedHead ?? '')) {
    throw new SingularityFlowError('Generation publication is missing its transaction, parent, event, or durable path.', {
      code: 'GENERATION_PUBLICATION_BINDING_REQUIRED'
    });
  }
  const core = {
    schemaVersion: currentSchemaVersion('generation-publication'),
    kind: 'generation-publication',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.generation,
    generationIntentId: phase.generationIntent?.id ?? null,
    generationStart: phase.generationIntent ? {
      path: phase.generationIntent.path,
      sha256: phase.generationIntent.receiptSha256
    } : null,
    changeSet: {
      path: phase.deliveryEvidence?.changeSetPath ?? null,
      digest: publication.changeSetDigest ?? null
    },
    resultDigest: publication.resultDigest ?? null,
    baseline: {
      commit: phase.generationIntent?.baseline?.commit ?? expectedHead,
      tree: phase.generationIntent?.baseline?.tree
        ?? run('git', ['rev-parse', `${expectedHead}^{tree}`], { cwd: root }).stdout.trim()
    },
    transactionId,
    eventId: publicationEvent.eventId,
    eventSha256: sha256Record(publicationEvent),
    commitBinding: {
      method: 'containing-governed-transaction',
      commit: '$self',
      tree: '$self',
      parent: expectedHead
    },
    publishedAt: publication.publishedAt
  };
  const record = { ...core, recordSha256: sha256Record(core) };
  await writeJson(path.join(root, recordPath), record);
  publication.record = { path: recordPath, sha256: record.recordSha256 };
  if (phase.generationIntent?.publication) phase.generationIntent.publication.record = publication.record;
  return { path: recordPath, record };
}

/** Resolve the exact verified generation commit; presentation subjects only enumerate legacy candidates. */
export function publishedGenerationCommit(root, workflow, phase, number = phase.generation) {
  const generation = Number(number);
  if (!Number.isInteger(generation) || generation < 1) return null;
  const workId = workflow.workItem.id;
  const publication = (phase.generationPublications ?? [])
    .find((entry) => Number(entry.generation) === generation);
  const recordPath = publication?.record?.path
    ?? (Number(phase.generationIntent?.generation) === generation
      ? phase.generationIntent?.publication?.record?.path : null)
    ?? generationPublicationRelative(phase, generation);
  if (recordPath) {
    const commits = run('git', ['log', '--format=%H', '--diff-filter=A', '--', recordPath], {
      cwd: root, allowFailure: true
    }).stdout.split(/\r?\n/).filter(Boolean);
    const checked = commits.map((commit) => {
      try {
        const record = readAt(root, commit, recordPath, 'generation-publication');
        return verifyCommittedEvidence(root, commit, {
          record, recordPath, workId, phaseId: phase.id, generation
        });
      } catch (error) { return { valid: false, commit, reason: error.message }; }
    });
    const valid = checked.filter((entry) => entry.valid);
    if (valid.length === 1) return valid[0].commit;
    if (commits.length) {
      throw new SingularityFlowError(
        valid.length > 1
          ? `Generation ${generation} has multiple valid publication records.`
          : `Generation ${generation} publication record does not verify against its governed commit.`,
        {
          code: valid.length > 1 ? 'GENERATION_PUBLICATION_AMBIGUOUS' : 'GENERATION_PUBLICATION_INVALID',
          details: { workId, phase: phase.id, generation, recordPath, candidates: checked }
        }
      );
    }
  }

  const subject = `[${workId}][phase:${phase.id}][generated:${generation}]`;
  const candidates = run('git', ['log', '--format=%H%x09%s', '--fixed-strings', '--grep', subject], {
    cwd: root, allowFailure: true
  }).stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'))
    .filter(([, message]) => message.startsWith(subject)).map(([commit]) => commit);
  const legacyPath = generationPublicationRelative(phase, generation);
  if (!legacyPath) return null;
  const verified = candidates.map((commit) => verifyCommittedEvidence(root, commit, {
    recordPath: legacyPath, workId, phaseId: phase.id, generation, legacy: true
  }));
  const valid = verified.filter((entry) => entry.valid);
  if (!candidates.length) return null;
  // A verified legacy candidate is useful migration evidence, but it is not the immutable
  // Generation Publication Record required by current releases. Returning it here would silently
  // preserve the very commit-message fallback this boundary was introduced to remove. Recovery
  // receives the exact candidate and must create an explicit, reviewable migration receipt before
  // a later generation can use it as authority.
  if (valid.length === 1) {
    throw new SingularityFlowError(
      `Generation ${generation} has one evidence-valid legacy candidate, but no immutable publication record. Create and review a generation-publication migration receipt before beginning another generation.`,
      {
        code: 'GENERATION_PUBLICATION_MIGRATION_REQUIRED',
        details: {
          workId, phase: phase.id, generation,
          verifiedCandidate: valid[0],
          candidates: verified
        }
      }
    );
  }
  throw new SingularityFlowError(
    valid.length > 1
      ? `Generation ${generation} has multiple evidence-valid legacy publication candidates.`
      : `Generation ${generation} has no evidence-valid publication candidate. Commit-message matching is not authority.`,
    {
      code: valid.length > 1 ? 'GENERATION_PUBLICATION_AMBIGUOUS' : 'GENERATION_PUBLICATION_MIGRATION_REQUIRED',
      details: { workId, phase: phase.id, generation, candidates: verified }
    }
  );
}
