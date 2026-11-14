import { nextPhaseGeneration } from './phase-generation.mjs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import {
  buildRepositoryChangeSet, changeSetPaths, evaluateProtectedPaths, evaluateSourceBoundary
} from './repository-change-set.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { canonicalJson } from './records.mjs';
import {
  persistGenerationPublicationRecord, publishedGenerationCommit
} from './generation-publication-store.mjs';
import { beginTelemetryCapture } from './telemetry.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { applicationChangeSetProjection, applicationPathContext } from './work-intervals.mjs';
import { nowIso, posix, readJson, SingularityFlowError, writeJson } from './util.mjs';

function receiptRelative(config, workflow, phase, generation) {
  return posix(path.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    'context', 'generation-start', `${phase.id}-gen${generation}.json`
  ));
}

function generationStartSha256(record) {
  const { receiptSha256: _receiptSha256, ...content } = record ?? {};
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`;
}

export { persistGenerationPublicationRecord, publishedGenerationCommit };

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
  const expectedGeneration = nextPhaseGeneration(phase);
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
 * The scope a generation starts under: the latest scope revision and the last approved intent amendment. Recorded on a
 * code generation's start and a composed prompt's receipt when the Story's pinned spec policy refuses drafts written
 * before an approved amendment (SPEC-CIC switch 2), and checked at its publication [CIC:REQ-008, REQ-009].
 */
export function generationScope(workflow) {
  const latest = workflow?.scopeRevisions?.at(-1) ?? null;
  const amendment = (workflow?.intentAmendments ?? []).filter((entry) => ['approved', 'revalidated'].includes(entry?.status)).at(-1)?.id ?? null;
  return { revision: latest?.revision ?? 0, revisionSha256: latest?.revisionSha256 ?? null, amendment };
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
  const generation = nextPhaseGeneration(phase);
  if (phase.generationIntent?.status === 'open' && Number(phase.generationIntent.generation) === generation) {
    if (persist) await verifiedIntentRecord(root, workflow, phase, phase.generationIntent);
    return phase.generationIntent;
  }
  const interval = workflow.workIntervals?.current;
  if (!interval || interval.phaseId !== phase.id || interval.status !== 'open') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' has no open work interval. Prepare the phase before beginning code generation.`,
      { code: 'GENERATION_INTENT_REQUIRED' }
    );
  }
  const previousGenerationCommit = Number(phase.generation ?? 0) > 0
    ? publishedGenerationCommit(root, workflow, phase, phase.generation)
    : null;
  if (Number(phase.generation ?? 0) > 0 && !previousGenerationCommit) {
    throw new SingularityFlowError(
      `Published commit for ${phase.id} generation ${phase.generation} is unavailable; recover synchronization before beginning another generation.`,
      { code: 'GENERATION_INTENT_REQUIRED' }
    );
  }
  const baselineCommit = previousGenerationCommit ?? interval.sourceBaseCommit;
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: baselineCommit,
    subject: { workId: workflow.workItem.id, phase: phase.id, generation, generationIntentId: null }
  });
  const applicationChangeSet = applicationChangeSetProjection(
    changeSet, applicationPathContext(config, workflow)
  );
  const existing = applicationChangeSet.entries;
  const dirtyPolicy = workflow.resolution?.codeDelivery?.generationBoundary?.dirtyStart ?? 'block';
  const changedPaths = changeSetPaths(applicationChangeSet, { bothEndpoints: true });
  const protectedGuards = [
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ];
  const protectedPaths = [...new Set(evaluateProtectedPaths(applicationChangeSet, protectedGuards)
    .violations.map((item) => item.path))].sort();
  const outsideSourceBoundaryPaths = [...new Set(evaluateSourceBoundary(
    applicationChangeSet, phase.sourceBoundary ?? 'unrestricted', {
      phaseId: phase.id, allowedPath: isTestAutomationPath
    }
  ).violations.map((item) => item.path))].sort();
  const dirtyDetails = {
    workId: workflow.workItem.id,
    baselineCommit,
    generation,
    changedPaths,
    changeSetDigest: applicationChangeSet.digest,
    dirtyStartPolicy: dirtyPolicy,
    boundary: previousGenerationCommit ? 'since-previous-generation' : 'before-first-generation',
    classification: {
      preBoundaryPaths: previousGenerationCommit ? [] : changedPaths,
      boundedRolloverPaths: previousGenerationCommit ? changedPaths : [],
      protectedPaths,
      outsideSourceBoundaryPaths
    }
  };
  // A generation an approved amendment closed unpublished (SPEC-CIC switch 2) changed code inside governance: the next
  // one, from the same baseline, carries it, never as work from before the first begin [CIC:REQ-009].
  const closed = phase.generationIntent;
  const carried = closed?.status === 'superseded' && Number(closed.generation) === generation && closed.baseline?.commit === baselineCommit ? closed.id : null;
  const initialAdoptionBlocked = !previousGenerationCommit
    && dirtyPolicy !== 'allow-explicit-adoption' && !carried;
  if (existing.length && (protectedPaths.length || outsideSourceBoundaryPaths.length)) {
    throw new SingularityFlowError(
      `Code changed outside the phase's allowed source scope before generation begin. `
      + `Preserve and review the ${changedPaths.length} changed path(s), restore protected or out-of-boundary paths to the baseline, then retry generation begin.`,
      { code: 'GENERATION_DIRTY_START', details: dirtyDetails }
    );
  }
  if (existing.length && !adoptExisting && !carried) {
    if (initialAdoptionBlocked) {
      throw new SingularityFlowError(
        `Code already changed before the first generation began (${changedPaths.length} path(s)). `
        + 'This Story policy blocks adoption. Review and preserve the listed changes outside this Story checkout, '
        + 'return the checkout to its baseline, then begin generation and reapply the reviewed changes.',
        { code: 'GENERATION_DIRTY_START', details: dirtyDetails }
      );
    }
    // Only `phase begin` adopts: `prepare`, which also opens a code generation, takes no adoption
    // flags, so the refusal names the exact command whichever of the two met the changes.
    const adopt = `singularity-flow phase begin ${phase.id} --adopt-existing --confirm ${applicationChangeSet.digest}`;
    throw new SingularityFlowError(
      `Code already changed before generation begin (${changedPaths.length} path(s)). After reviewing the full application change set, adopt it with: ${adopt}`,
      { code: 'GENERATION_DIRTY_START', details: { ...dirtyDetails, phase: phase.id, nextAction: {
        command: adopt, label: 'After a person reviews the listed changes (details.changedPaths), adopt exactly this change set into the new generation.'
      } } }
    );
  }
  if (adoptExisting) {
    // `dirtyStart` protects generation 1 from inheriting unbounded work that predates governance.
    // A later generation is different: its baseline is the exact prior generated commit and the
    // contributor confirms the digest of only the post-publication delta. Permit that bounded
    // rollover so a failed submit can be repaired without weakening initial dirty-start policy.
    if (initialAdoptionBlocked) {
      throw new SingularityFlowError(
        'This Story policy blocks adoption of changes made before the first generation. Review and preserve the listed changes outside this Story checkout, return the checkout to its baseline, then begin generation and reapply the reviewed changes.',
        { code: 'GENERATION_DIRTY_START', details: dirtyDetails }
      );
    }
    if (!confirm || confirm !== applicationChangeSet.digest) {
      throw new SingularityFlowError(`Adoption confirmation must equal the current application change-set digest ${applicationChangeSet.digest}.`, {
        code: 'GENERATION_DIRTY_START', details: dirtyDetails
      });
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
      commit: baselineCommit,
      tree: changeSet.base.tree,
      initialChangeSetDigest: applicationChangeSet.digest,
      mode: existing.length ? (carried && !adoptExisting ? 'carried' : 'adopted') : 'clean',
      previousGenerationCommit,
      ...(carried ? { carriedFrom: carried } : {})
    },
    grounding: {
      compositionSha256: phase.grounding?.compositionSha256 ?? null,
      promptSha256: phase.grounding?.promptSha256 ?? null
    },
    inputs: { renderedSha256: inputRenderedSha256 ?? phase.inputContext?.renderedSha256 ?? null },
    sourceBoundary: phase.sourceBoundary ?? 'unrestricted',
    ...(workflow.resolution?.spec?.preAmendmentDrafts === 'refuse' ? { scopeRevision: generationScope(workflow) } : {}),
    startedAt,
    startedBy: { actor, agent },
    telemetryCursor: { key: `${workflow.workItem.id}:${phase.id}:${generation}`, startedAt: telemetry.startedAt },
    adoption: existing.length ? { confirmedDigest: applicationChangeSet.digest, paths: existing.length } : null
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
    ...(receipt.scopeRevision ? { scopeRevision: receipt.scopeRevision } : {}),
    publication: null
  };
  if (persist) await writeJson(path.join(root, receiptPath), receipt);
  return phase.generationIntent;
}

/**
 * A code generation an approved amendment closed before it published (SPEC-CIC switch 2, amended-drafts.mjs): its draft
 * is from before the amended scope, and its way out is in this step: begin it again, then compose it again [CIC:REQ-009].
 */
function closedByAmendment(workflow, phase, intent) {
  const workId = workflow.workItem.id;
  const actions = [
    { command: `singularity-flow phase begin ${phase.id} --work-id ${workId} --json`, skill: '/sf-code', detail: `Open ${phase.id}'s code generation again under the amended scope.` },
    { command: `singularity-flow phase enter ${phase.id} --work-id ${workId} --compose --for-agent --json`, detail: `Compose ${phase.id} again under the amended scope, and write it from that prompt.` }];
  const kept = phase.scopePin?.draft?.path;
  return new SingularityFlowError(`${phase.id} cannot publish this draft: its code generation was closed when ${intent.supersededBy} amended the scope${phase.scopePin?.revision ? ` (scope revision ${phase.scopePin.revision})` : ''}. `
    + `Write it again here, in ${phase.id}, under the amended scope: ${actions.map((action) => action.command).join(', then ')}.`
    + `${kept ? ` The earlier draft is kept read only at ${kept}; keep from it only what still holds under the amended scope.` : ''}`, {
    code: 'PHASE_DRAFT_PREDATES_AMENDMENT',
    details: { workId, phase: phase.id, amendment: intent.supersededBy, revision: phase.scopePin?.revision ?? null, reasons: ['generation'],
      readOnlyDraft: kept ?? null, codeStep: true, actions, nextAction: { command: actions[0].command, skill: '/sf-code', label: actions[0].detail } }
  });
}

export function requireOpenGenerationIntent(workflow, phase) {
  const required = workflow.resolution?.codeDelivery?.generationBoundary?.requireBegin !== false;
  if (!phaseRequiresCodeDelivery(phase) || !required) return null;
  const expectedGeneration = nextPhaseGeneration(phase);
  const intent = phase.generationIntent;
  if (intent?.status === 'superseded' && Number(intent.generation) === expectedGeneration) throw closedByAmendment(workflow, phase, intent);
  if (!intent || intent.status !== 'open' || Number(intent.generation) !== expectedGeneration) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' requires an open generation intent. Run singularity-flow phase begin ${phase.id} before changing source.`,
      { code: 'GENERATION_INTENT_REQUIRED', details: { nextAction: `singularity-flow phase begin ${phase.id}` } }
    );
  }
  return intent;
}

export async function verifyOpenGenerationIntent(root, workflow, phase) {
  const intent = requireOpenGenerationIntent(workflow, phase);
  if (!intent) return null;
  await verifiedIntentRecord(root, workflow, phase, intent);
  const expectedBaseline = Number(phase.generation) > 0
    ? publishedGenerationCommit(root, workflow, phase, phase.generation)
    : workflow.workIntervals?.current?.sourceBaseCommit ?? null;
  if (!expectedBaseline || intent.baseline?.commit !== expectedBaseline) {
    throw new SingularityFlowError('The generation intent no longer matches its generation baseline.', {
      code: 'GENERATION_INTENT_REQUIRED'
    });
  }
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
    previousGenerationCommit: receipt.baseline?.previousGenerationCommit
      ?? phase.deliveryEvidence?.tree?.generationCommit ?? null
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
    resultDigestVersion: publication.resultDigestVersion ?? 1,
    generationStartSha256: phase.generationIntent.receiptSha256
  };
  return phase.generationIntent;
}
