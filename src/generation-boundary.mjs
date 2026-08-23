import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { canonicalJson } from './records.mjs';
import { beginTelemetryCapture } from './telemetry.mjs';
import { isApplicationChangeEntry } from './work-intervals.mjs';
import { nowIso, posix, readJson, SingularityFlowError, writeJson } from './util.mjs';

function receiptRelative(config, workflow, phase, generation) {
  return posix(path.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    'context', 'generation-start', `${phase.id}-gen${generation}.json`
  ));
}

function currentApplicationEntries(changeSet) {
  return (changeSet.entries ?? []).filter(isApplicationChangeEntry);
}

function generationStartSha256(record) {
  const { receiptSha256: _receiptSha256, ...content } = record ?? {};
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`;
}

async function verifiedIntentRecord(root, workflow, phase, intent) {
  if (!intent?.path) {
    throw new SingularityFlowError('The open generation intent has no durable receipt path.', { code: 'GENERATION_INTENT_REQUIRED' });
  }
  let receipt;
  try { receipt = readRecord('generation-start', await readJson(path.join(root, intent.path))).record; }
  catch (error) {
    throw new SingularityFlowError(`The generation-start receipt is unavailable or unreadable: ${error.message}`, {
      code: 'GENERATION_INTENT_REQUIRED', cause: error
    });
  }
  const expectedGeneration = Number(phase.generation ?? 0) + 1;
  const receiptSha256 = generationStartSha256(receipt);
  if (receipt.kind !== 'generation-start'
      || receipt.generationIntentId !== intent.id
      || receipt.workId !== workflow.workItem.id
      || receipt.phase !== phase.id
      || Number(receipt.generation) !== expectedGeneration
      || receipt.status !== 'open'
      || receipt.baseline?.commit !== intent.baseline?.commit
      || receipt.receiptSha256 !== receiptSha256
      || intent.receiptSha256 !== receiptSha256) {
    throw new SingularityFlowError('The open generation intent differs from its durable generation-start receipt.', {
      code: 'GENERATION_INTENT_REQUIRED'
    });
  }
  return receipt;
}

/**
 * Establish the immutable authoring boundary. Repeating begin for the same open generation is a
 * read-equivalent operation and returns the existing intent.
 */
export async function beginCodeGeneration(root, config, workflow, phase, {
  adoptExisting = false,
  confirm = null,
  actor = null,
  agent = null,
  inputRenderedSha256 = null,
  persist = true
} = {}) {
  if (!phaseRequiresCodeDelivery(phase)) {
    throw new SingularityFlowError(`Phase '${phase.id}' is not a code-generation phase.`, { code: 'GENERATION_INTENT_NOT_APPLICABLE' });
  }
  const generation = Number(phase.generation ?? 0) + 1;
  if (phase.generationIntent?.status === 'open' && Number(phase.generationIntent.generation) === generation) {
    if (persist) await verifiedIntentRecord(root, workflow, phase, phase.generationIntent);
    return phase.generationIntent;
  }
  const interval = workflow.workIntervals?.current;
  if (!interval || interval.phaseId !== phase.id || interval.status !== 'open') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' has no open governed work interval. Prepare the phase before beginning code generation.`,
      { code: 'GENERATION_INTENT_REQUIRED' }
    );
  }
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: interval.sourceBaseCommit,
    subject: { workId: workflow.workItem.id, phase: phase.id, generation, generationIntentId: null }
  });
  const existing = currentApplicationEntries(changeSet);
  const dirtyPolicy = workflow.resolution?.codeDelivery?.generationBoundary?.dirtyStart ?? 'block';
  if (existing.length && !adoptExisting) {
    throw new SingularityFlowError(
      `Code already changed before generation begin. Re-run with --adopt-existing --confirm ${changeSet.digest} only after reviewing the full change set.`,
      { code: 'GENERATION_DIRTY_START' }
    );
  }
  if (adoptExisting) {
    if (dirtyPolicy !== 'allow-explicit-adoption') {
      throw new SingularityFlowError('This Story policy does not permit adoption of existing source changes.', { code: 'GENERATION_DIRTY_START' });
    }
    if (!confirm || confirm !== changeSet.digest) {
      throw new SingularityFlowError(`Adoption confirmation must equal the current change-set digest ${changeSet.digest}.`, { code: 'GENERATION_DIRTY_START' });
    }
  }
  const telemetry = await beginTelemetryCapture(root, workflow, phase);
  const startedAt = nowIso();
  const intentId = randomUUID();
  const receiptPath = receiptRelative(config, workflow, phase, generation);
  const receiptContent = {
    schemaVersion: currentSchemaVersion('generation-start'),
    kind: 'generation-start',
    generationIntentId: intentId,
    workId: workflow.workItem.id,
    phase: phase.id,
    generation,
    task: 'code',
    status: 'open',
    baseline: {
      commit: interval.sourceBaseCommit,
      tree: changeSet.base.tree,
      initialChangeSetDigest: changeSet.digest,
      mode: existing.length ? 'adopted' : 'clean'
    },
    grounding: {
      compositionSha256: phase.grounding?.compositionSha256 ?? null,
      promptSha256: phase.grounding?.promptSha256 ?? null
    },
    inputs: { renderedSha256: inputRenderedSha256 ?? phase.inputContext?.renderedSha256 ?? null },
    sourceBoundary: phase.sourceBoundary ?? 'unrestricted',
    startedAt,
    startedBy: { actor, agent },
    telemetryCursor: { key: `${workflow.workItem.id}:${phase.id}:${generation}`, startedAt: telemetry.startedAt },
    adoption: existing.length ? { confirmedDigest: changeSet.digest, paths: existing.length } : null
  };
  const receipt = { ...receiptContent, receiptSha256: generationStartSha256(receiptContent) };
  phase.generationIntent = {
    id: intentId,
    generation,
    status: 'open',
    path: receiptPath,
    receiptSha256: receipt.receiptSha256,
    baseline: receipt.baseline,
    startedAt,
    startedBy: receipt.startedBy,
    publication: null
  };
  if (persist) await writeJson(path.join(root, receiptPath), receipt);
  return phase.generationIntent;
}

export function requireOpenGenerationIntent(workflow, phase) {
  const required = workflow.resolution?.codeDelivery?.generationBoundary?.requireBegin !== false;
  if (!phaseRequiresCodeDelivery(phase) || !required) return null;
  const expectedGeneration = Number(phase.generation ?? 0) + 1;
  const intent = phase.generationIntent;
  if (!intent || intent.status !== 'open' || Number(intent.generation) !== expectedGeneration) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' requires an open generation intent. Run singularity-flow phase begin ${phase.id} before changing source.`,
      { code: 'GENERATION_INTENT_REQUIRED' }
    );
  }
  if (intent.baseline?.commit && intent.baseline.commit !== workflow.workIntervals?.current?.sourceBaseCommit) {
    throw new SingularityFlowError('The generation intent no longer matches the governed work-interval baseline.', { code: 'GENERATION_INTENT_REQUIRED' });
  }
  return intent;
}

export async function verifyOpenGenerationIntent(root, workflow, phase) {
  const intent = requireOpenGenerationIntent(workflow, phase);
  if (!intent) return null;
  await verifiedIntentRecord(root, workflow, phase, intent);
  return intent;
}

/**
 * Verify and expose the immutable generation-start provenance bound into publication.
 *
 * Beginning work is not a lifecycle transition. The later artifact-generated event carries this
 * exact receipt hash so the publication can prove which local authoring boundary it consumed.
 */
export async function generationStartPublicationBinding(root, workflow, phase) {
  const intent = requireOpenGenerationIntent(workflow, phase);
  if (!intent) return null;
  const receipt = await verifiedIntentRecord(root, workflow, phase, intent);
  return Object.freeze({
    generationIntentId: receipt.generationIntentId,
    generationStartPath: intent.path,
    generationStartSha256: receipt.receiptSha256,
    baselineCommit: receipt.baseline?.commit ?? null,
    baselineTree: receipt.baseline?.tree ?? null,
    initialChangeSetDigest: receipt.baseline?.initialChangeSetDigest ?? null,
    previousGenerationCommit: phase.deliveryEvidence?.tree?.generationCommit ?? null
  });
}

export async function consumeGenerationIntent(root, phase, publication) {
  if (!phase.generationIntent) return null;
  if (phase.generationIntent.path) {
    const receipt = readRecord(
      'generation-start',
      await readJson(path.join(root, phase.generationIntent.path))
    ).record;
    const receiptSha256 = generationStartSha256(receipt);
    if (receipt.status !== 'open'
        || receipt.receiptSha256 !== receiptSha256
        || phase.generationIntent.receiptSha256 !== receiptSha256) {
      throw new SingularityFlowError('The generation-start receipt changed before publication could consume it.', {
        code: 'GENERATION_INTENT_REQUIRED'
      });
    }
  }
  phase.generationIntent.status = 'consumed';
  phase.generationIntent.consumedAt = publication.publishedAt;
  phase.generationIntent.publication = {
    generation: publication.generation,
    changeSetDigest: publication.changeSetDigest,
    resultDigest: publication.resultDigest ?? null,
    generationStartSha256: phase.generationIntent.receiptSha256
  };
  return phase.generationIntent;
}
