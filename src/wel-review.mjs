/** Pure validation for WEL decisions carried by the existing phase approval authority. */
import { SingularityFlowError } from './util.mjs';
import { recordSha256 } from './records.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DECISIONS = new Set(['satisfied', 'exception', 'not-applicable']);
const MAX_MAPPINGS = 1000;
const MAX_REASON_BYTES = 4096;

export function evaluateWitnessMappingReview({ mappings = [], decisions = [], now = Date.now() } = {}) {
  if (!Array.isArray(mappings) || mappings.length > MAX_MAPPINGS
      || !Array.isArray(decisions) || decisions.length > MAX_MAPPINGS) {
    throw new SingularityFlowError(`Witness mapping review exceeds ${MAX_MAPPINGS} entries.`, {
      code: 'WEL_WITNESS_MAPPING_UNREVIEWED'
    });
  }
  const expected = new Map();
  const errors = [];
  for (const mapping of mappings) {
    const core = {
      sourceProposalSha256: mapping?.sourceProposalSha256,
      clauseId: mapping?.clauseId,
      witnessType: mapping?.witnessType,
      executionProfile: mapping?.executionProfile,
      logicalTestId: mapping?.logicalTestId,
      sourcePath: mapping?.sourcePath,
      sourceDeclarationSha256: mapping?.sourceDeclarationSha256,
      parserManifestSha256: mapping?.parserManifestSha256,
      clauseBodySha256: mapping?.clauseBodySha256
    };
    const validCore = DIGEST.test(core.sourceProposalSha256 ?? '')
      && /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/.test(core.clauseId ?? '')
      && core.witnessType === 'test'
      && core.executionProfile === 'junit5-surefire-v1'
      && DIGEST.test(core.logicalTestId ?? '')
      && typeof core.sourcePath === 'string' && core.sourcePath.length > 0
      && !core.sourcePath.startsWith('/') && !core.sourcePath.includes('\\')
      && !core.sourcePath.split('/').includes('..')
      && !/[\u0000-\u001f\u007f]/u.test(core.sourcePath)
      && DIGEST.test(core.sourceDeclarationSha256 ?? '')
      && DIGEST.test(core.parserManifestSha256 ?? '')
      && DIGEST.test(core.clauseBodySha256 ?? '');
    if (!validCore
        || mapping?.mappingSha256 !== `sha256:${recordSha256(core)}`
        || expected.has(mapping.mappingSha256)) {
      errors.push(`invalid or repeated witness mapping '${mapping?.mappingSha256 ?? '(missing)'}'`);
      continue;
    }
    expected.set(mapping.mappingSha256, mapping);
  }
  const seen = new Set();
  const reviewed = [];
  for (const entry of decisions) {
    const mapping = expected.get(entry?.mappingSha256);
    if (!mapping) {
      errors.push(`unknown witness mapping '${entry?.mappingSha256 ?? '(missing)'}'`);
      continue;
    }
    if (seen.has(entry.mappingSha256)) {
      errors.push(`witness mapping '${entry.mappingSha256}' was decided more than once`);
      continue;
    }
    seen.add(entry.mappingSha256);
    if (!DECISIONS.has(entry.decision)) {
      errors.push(`witness mapping '${entry.mappingSha256}' has an invalid decision`);
      continue;
    }
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (entry.decision !== 'satisfied' && !reason) {
      errors.push(`witness mapping '${entry.mappingSha256}' requires a reason for ${entry.decision}`);
      continue;
    }
    if (Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
      errors.push(`witness mapping '${entry.mappingSha256}' reason is not bounded review text`);
      continue;
    }
    let expiresAt = null;
    if (entry.decision === 'exception') {
      const parsed = Date.parse(entry.expiresAt ?? '');
      if (!Number.isFinite(parsed) || parsed <= now) {
        errors.push(`witness mapping '${entry.mappingSha256}' exception requires a future ISO expiry`);
        continue;
      }
      expiresAt = new Date(parsed).toISOString();
    }
    reviewed.push({
      mappingSha256: mapping.mappingSha256,
      sourceProposalSha256: mapping.sourceProposalSha256,
      clauseId: mapping.clauseId,
      clauseBodySha256: mapping.clauseBodySha256,
      logicalTestId: mapping.logicalTestId,
      sourceDeclarationSha256: mapping.sourceDeclarationSha256,
      decision: entry.decision,
      reason: reason || null,
      expiresAt
    });
  }
  for (const mapping of expected.values()) {
    if (!seen.has(mapping.mappingSha256)) {
      errors.push(`witness mapping '${mapping.mappingSha256}' has no review decision`);
    }
  }
  reviewed.sort((left, right) => left.mappingSha256.localeCompare(right.mappingSha256));
  return Object.freeze({ valid: errors.length === 0, errors, decisions: reviewed });
}
