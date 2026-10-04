/**
 * Witness adequacy review, carried by the existing phase approval authority [E2G-014].
 *
 * Each proposal is one exact test the submitted delivery ties to a criterion, bound to the
 * criterion's exact text, the test's exact revision, its adapter profile and the contract slot it
 * serves. Approving the step accepts every proposal as adequate on all five facets (setup and inputs,
 * the action, the assertions, negative and boundary cases, and the relationship to the
 * implementation), as one batch over their exact digests. A reviewer records an exception (naming the
 * inadequate facets, with a reason and an expiry) or rules a test out (not-applicable, with a
 * reason). A decision made earlier for an identical proposal carries forward; any changed digest is
 * a new proposal. Pure.
 */
import { SingularityFlowError } from './util.mjs';
import { recordSha256 } from './records.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DECISIONS = new Set(['satisfied', 'exception', 'not-applicable']);
const MAX_MAPPINGS = 1000;
const MAX_REASON_BYTES = 4096;
const REVIEWED_EXECUTION_PROFILES = new Set([
  'jest-static-v2', 'vitest-static-v2', 'junit5-surefire-v2', 'junit5-gradle-v2', 'node-test-v1'
]);
/** The adequacy facets a reviewer judges for each witness [E2G-014]. */
export const ADEQUACY_FACETS = Object.freeze(['setup', 'action', 'assertions', 'boundaries', 'implementation']);

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f]/u.test(value);
}

function mappingCore(mapping) {
  return {
    clauseId: mapping?.clauseId,
    witnessType: mapping?.witnessType,
    executionProfile: mapping?.executionProfile,
    logicalTestId: mapping?.logicalTestId,
    sourcePath: mapping?.sourcePath,
    sourceDeclarationSha256: mapping?.sourceDeclarationSha256,
    supportSha256: mapping?.supportSha256 ?? null,
    clauseBodySha256: mapping?.clauseBodySha256,
    contractSha256: mapping?.contractSha256 ?? null,
    slot: mapping?.slot ?? null
  };
}

function adequacyOf(decision, inadequate = []) {
  if (decision === 'not-applicable') return null;
  return Object.fromEntries(ADEQUACY_FACETS.map((facet) => [facet, inadequate.includes(facet) ? 'inadequate' : 'adequate']));
}

/**
 * The reviewed decisions for every submitted proposal. `decisions` are the reviewer's explicit
 * ones; `prior` are decisions recorded by earlier approvals of the same step.
 */
export function evaluateWitnessMappingReview({ mappings = [], decisions = [], prior = [], now = Date.now() } = {}) {
  if (!Array.isArray(mappings) || mappings.length > MAX_MAPPINGS
      || !Array.isArray(decisions) || decisions.length > MAX_MAPPINGS) {
    throw new SingularityFlowError(`Witness mapping review exceeds ${MAX_MAPPINGS} entries.`, {
      code: 'WEL_WITNESS_MAPPING_UNREVIEWED'
    });
  }
  const expected = new Map();
  const errors = [];
  for (const mapping of mappings) {
    const core = mappingCore(mapping);
    const validCore = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/.test(core.clauseId ?? '')
      && core.witnessType === 'test'
      && REVIEWED_EXECUTION_PROFILES.has(core.executionProfile)
      && DIGEST.test(core.logicalTestId ?? '')
      && safePath(core.sourcePath)
      && DIGEST.test(core.sourceDeclarationSha256 ?? '')
      && (core.supportSha256 === null || DIGEST.test(core.supportSha256))
      && DIGEST.test(core.clauseBodySha256 ?? '')
      && (core.contractSha256 === null || DIGEST.test(core.contractSha256))
      && (core.slot === null || /^[a-z][a-z0-9-]{0,31}$/u.test(core.slot));
    if (!validCore || mapping?.mappingSha256 !== `sha256:${recordSha256(core)}` || expected.has(mapping.mappingSha256)) {
      errors.push(`invalid or repeated witness mapping '${mapping?.mappingSha256 ?? '(missing)'}'`);
      continue;
    }
    expected.set(mapping.mappingSha256, mapping);
  }
  const chosen = new Map();
  for (const entry of decisions) {
    const mapping = expected.get(entry?.mappingSha256);
    if (!mapping) {
      errors.push(`unknown witness mapping '${entry?.mappingSha256 ?? '(missing)'}'`);
      continue;
    }
    if (chosen.has(entry.mappingSha256)) {
      errors.push(`witness mapping '${entry.mappingSha256}' was decided more than once`);
      continue;
    }
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
    const inadequate = [...new Set(entry.inadequate ?? [])];
    if (entry.decision === 'exception'
        && (!inadequate.length || inadequate.some((facet) => !ADEQUACY_FACETS.includes(facet)))) {
      errors.push(`witness mapping '${entry.mappingSha256}' exception must name its inadequate facets from ${ADEQUACY_FACETS.join(', ')}`);
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
    chosen.set(entry.mappingSha256, {
      decision: entry.decision, reason: reason || null, expiresAt,
      adequacy: adequacyOf(entry.decision, entry.decision === 'exception' ? inadequate : []), source: 'explicit'
    });
  }
  // An earlier decision on an identical proposal carries forward; a lapsed exception does not.
  const carried = new Map();
  for (const entry of prior) {
    if (!expected.has(entry?.mappingSha256) || carried.has(entry.mappingSha256) || !DECISIONS.has(entry.decision)) continue;
    if (entry.decision === 'exception' && !(Date.parse(entry.expiresAt ?? '') > now)) continue;
    carried.set(entry.mappingSha256, {
      decision: entry.decision, reason: entry.reason ?? null, expiresAt: entry.expiresAt ?? null,
      adequacy: entry.adequacy ?? adequacyOf(entry.decision), source: 'carried-forward'
    });
  }
  const reviewed = [...expected.values()].map((mapping) => ({
    mappingSha256: mapping.mappingSha256,
    clauseId: mapping.clauseId,
    clauseBodySha256: mapping.clauseBodySha256,
    logicalTestId: mapping.logicalTestId,
    sourcePath: mapping.sourcePath,
    sourceDeclarationSha256: mapping.sourceDeclarationSha256,
    slot: mapping.slot ?? null,
    ...(chosen.get(mapping.mappingSha256) ?? carried.get(mapping.mappingSha256)
      ?? { decision: 'satisfied', reason: null, expiresAt: null, adequacy: adequacyOf('satisfied'), source: 'batch' })
  }));
  reviewed.sort((left, right) => left.mappingSha256.localeCompare(right.mappingSha256));
  return Object.freeze({ valid: errors.length === 0, errors, decisions: reviewed });
}
