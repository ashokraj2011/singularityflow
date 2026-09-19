import {
  persistedOverviewCanonicalJsonV1 as canonicalJson,
  persistedOverviewContractFailureV1 as contractFailure,
  persistedOverviewSha256V1 as sha256,
  renderPersistedOverviewViewV1
} from '../materialize/persisted-overview-renderer-v1.mjs';

const EXPECTED_MEDIA_TYPES = Object.freeze({
  json: 'application/json',
  md: 'text/markdown'
});

function fail(message, details = {}) {
  contractFailure(message, 'WMP_VIEW_REPLAY_MISMATCH', details);
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail(`${label} must be supplied as exact retained bytes.`);
}

/**
 * Convert unavailable View Inputs into the renderer's closed gap grammar. The digest suffix and
 * inputSha256 bind every displayed limitation to the complete retained capture without exposing a
 * machine path or depending on presentation text supplied by a caller.
 */
export function persistedOverviewCapturedInputGaps(viewInputs) {
  return viewInputs.captures
    .filter((capture) => capture.status !== 'available')
    .map((capture) => {
      const inputSha256 = sha256({
        kind: 'wmp/persisted-overview-input-gap',
        version: 1,
        role: capture.role,
        subject: capture.subject,
        status: capture.status,
        reason: capture.reason
      });
      return {
        id: `capture.${capture.role}.${inputSha256.slice('sha256:'.length, 'sha256:'.length + 16)}`,
        status: capture.status,
        reason: `${capture.reason.code}; observation-boundary=${capture.reason.observationBoundarySha256}; applicability=${capture.reason.applicabilitySha256}`,
        inputSha256
      };
    });
}

/**
 * Replay the installed deterministic renderer over an already admitted persisted graph and prove
 * that the retained bytes, inline Fact partition, and byte measurement are exactly reproducible.
 * A passed receipt is evidence only after this independent replay succeeds.
 */
export function verifyPersistedOverviewCandidateV1({
  binding,
  viewInputs,
  projectedFactLedger,
  selectedFactLedger,
  viewContract,
  rendererContract,
  renderedBytes
}) {
  const retainedBytes = exactBytes(renderedBytes, 'Persisted rendered view');
  const expectedMediaType = EXPECTED_MEDIA_TYPES[binding.inputs.format];
  if (binding.rendered.mediaType !== expectedMediaType) {
    fail('Persisted rendered view media type does not match its format.', {
      expected: expectedMediaType,
      received: binding.rendered.mediaType,
      format: binding.inputs.format
    });
  }
  const maximumBytes = rendererContract.maximumBytes[binding.inputs.variant];
  const replay = renderPersistedOverviewViewV1({
    viewContract,
    sourceFactLedger: projectedFactLedger,
    viewFactLedger: selectedFactLedger,
    capturedInputGaps: persistedOverviewCapturedInputGaps(viewInputs),
    variant: binding.inputs.variant,
    outputFormat: binding.inputs.format,
    maximumBytes,
    modelPayloadSha256: binding.inputs.modelPayloadSha256,
    viewInputsSha256: viewInputs.inputManifestSha256
  });
  const replayBytes = Buffer.from(replay.content, 'utf8');
  if (!replayBytes.equals(retainedBytes)) {
    fail('Persisted rendered view bytes do not equal a deterministic replay.', {
      expectedSha256: sha256(replayBytes),
      receivedSha256: sha256(retainedBytes),
      expectedBytes: replayBytes.length,
      receivedBytes: retainedBytes.length
    });
  }
  if (sha256(retainedBytes) !== binding.rendered.sha256
      || retainedBytes.length !== binding.rendered.bytes) {
    fail('Persisted rendered view bytes do not match their retained ObjectRef.', {
      expectedSha256: binding.rendered.sha256,
      receivedSha256: sha256(retainedBytes),
      expectedBytes: binding.rendered.bytes,
      receivedBytes: retainedBytes.length
    });
  }
  if (canonicalJson(replay.selectedFactIds) !== canonicalJson(binding.selection.selectedFactIds)
      || canonicalJson(replay.omittedFactIds) !== canonicalJson(binding.selection.omittedFactIds)) {
    fail('Persisted inline Fact selection does not equal the deterministic renderer selection.', {
      expectedSelectedFactIds: replay.selectedFactIds,
      receivedSelectedFactIds: binding.selection.selectedFactIds,
      expectedOmittedFactIds: replay.omittedFactIds,
      receivedOmittedFactIds: binding.selection.omittedFactIds
    });
  }
  if (binding.measurement.bytes !== replay.bytes
      || binding.measurement.tokens !== null
      || binding.measurement.tokenizerSha256 !== null) {
    fail('Persisted byte-only measurement does not equal the deterministic renderer measurement.', {
      expected: { bytes: replay.bytes, tokens: null, tokenizerSha256: null },
      received: binding.measurement
    });
  }
  return replay;
}
