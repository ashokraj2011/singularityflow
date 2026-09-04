import { readAutoFlightState } from '../auto/auto-flight-store.mjs';
import { loadDefinition } from '../config.mjs';
import { projectLegacyGdpCompatibility } from '../delivery-modes/compatibility-projection.mjs';
import { buildShadowChangePassport } from '../delivery-modes/shadow-passport.mjs';
import { branch, repoRoot } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { loadStoryAggregate, storyPublicationPending } from '../state-stores.mjs';
import { commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;

function prefixed(value) {
  const source = String(value ?? '');
  if (DIGEST.test(source)) return source;
  if (RAW_DIGEST.test(source)) return `sha256:${source}`;
  return null;
}

function findCandidate(workflow, autoFlight) {
  if (prefixed(autoFlight?.candidate?.candidateSha256)) return autoFlight.candidate;
  for (const phaseId of [...(workflow.phaseOrder ?? [])].reverse()) {
    const delivery = workflow.phases?.[phaseId]?.deliveryEvidence;
    for (const value of [delivery?.autoCandidate, delivery?.codeDelivery?.autoCandidate]) {
      if (prefixed(value?.candidateSha256)) return value;
    }
  }
  for (const value of [workflow.candidate, workflow.codeDelivery?.candidate]) {
    if (prefixed(value?.candidateSha256)) return value;
  }
  return null;
}

function digestRefs(value, keyPattern, output = new Set(), depth = 0) {
  if (depth > 10 || output.size >= 256 || value == null || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const exact = prefixed(child);
      if (exact) output.add(exact);
    }
    if (child && typeof child === 'object') digestRefs(child, keyPattern, output, depth + 1);
  }
  return output;
}

export async function run(_argv, { positionals, options, operation: suppliedOperation = null } = {}) {
  if (positionals?.[1] != null && positionals[1] !== 'show') throw new SingularityFlowError(
    `Unknown change action '${positionals[1]}'. Use: singularity-flow change show [WORK-ID] --shadow --json`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  if (!optionBoolean(options, 'shadow')) throw new SingularityFlowError(
    'The Change Passport is an advanced GDP-M2 diagnostic. Re-run with --shadow; it remains read-only and non-authoritative.',
    { code: 'GDP_SHADOW_FLAG_REQUIRED' }
  );
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const requested = positionals?.[2] ?? optionString(options, 'work-id') ?? branch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference: requested,
    kind: 'story',
    required: true
  });
  const workflow = await loadStoryAggregate(root, definition, selected.id);
  const autoFlight = workflow.executionOrigin?.flightId
    ? await readAutoFlightState(root, workflow.executionOrigin.flightId).catch((error) => {
      if (error?.code === 'AUTO_FLIGHT_NOT_FOUND') return null;
      throw error;
    })
    : null;
  const candidate = findCandidate(workflow, autoFlight);
  const projectedWorkflow = {
    ...workflow,
    ...(candidate ? { candidate: {
      ...candidate, candidateSha256: prefixed(candidate.candidateSha256)
    } } : {}),
    ...(workflow.worldModelReference == null && autoFlight?.worldModelReference
      ? { worldModelReference: autoFlight.worldModelReference } : {})
  };
  const pending = await storyPublicationPending(root, definition, workflow.workItem.id, { migrate: false });
  const compatibility = projectLegacyGdpCompatibility({
    sourceKind: 'workflow-story',
    record: projectedWorkflow,
    recovery: pending ? { status: 'recovery-required' } : null
  });
  const sourcePolicySha256 = prefixed(workflow.resolution?.policySha256)
    ?? compatibility.projectionSha256;
  const decisionRefs = [...digestRefs(workflow.phases, /(?:approval|decision).*Sha256$/iu)];
  // A test/evidence receipt is not publication authority. Only fields explicitly named as
  // publication digests belong in the Passport publication reference set.
  const publicationRefs = [...digestRefs(workflow.phases, /publication.*Sha256$/iu)];
  const diagnostic = buildShadowChangePassport({
    compatibility,
    sourcePolicySha256,
    sourceRecordSha256: `sha256:${recordSha256(compatibility)}`,
    proofProfile: optionString(options, 'proof-profile') ?? 'standard',
    decisionRefs,
    publicationRefs
  });
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: 'change.show.shadow', classification: 'read' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('change.shadow-reported', {
      workId: workflow.workItem.id,
      status: diagnostic.status,
      gaps: diagnostic.gaps.length
    }),
    effects: noEffects(),
    restState: 'informational',
    data: diagnostic
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
