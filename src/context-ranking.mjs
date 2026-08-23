/** Deterministic Evidence Packet ranking. Intent may choose a class; it never rewrites a fact. */
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const CONTEXT_REASON_PRIORITY = Object.freeze({
  'governance.mandatory': 0,
  'flight-plan.direct-target': 1,
  'flight-plan.proven-impact': 2,
  'requirement.bound-to-impact': 3,
  'architecture.boundary': 3,
  'ast.direct-neighbor': 4,
  'test.verifies-clause': 5,
  'phase.required-context': 6,
  'flight-plan.inferred-impact': 7,
  'historical-analogue': 8,
  'general.capability-context': 9,
  'human-requested-expansion': 1
});

const CLASSIFICATION_ORDER = Object.freeze({ proven: 0, inferred: 1, unknown: 2 });

function text(value) { return String(value ?? ''); }

function candidateIdentity(candidate) {
  return {
    kind: candidate.kind,
    subject: candidate.subject,
    classification: candidate.classification,
    representation: candidate.representation,
    reason: candidate.reason,
    source: candidate.source,
    mandatory: candidate.mandatory === true,
    contentSha256: recordSha256(text(candidate.content))
  };
}

export function normalizeContextCandidate(candidate) {
  const classification = ['proven', 'inferred', 'unknown'].includes(candidate?.classification)
    ? candidate.classification : 'unknown';
  const reasonCode = CONTEXT_REASON_PRIORITY[candidate?.reason?.code] != null
    ? candidate.reason.code : 'general.capability-context';
  const content = text(candidate?.content);
  const normalized = {
    kind: text(candidate?.kind || 'context-reference'),
    subject: text(candidate?.subject || 'unknown'),
    classification,
    representation: text(candidate?.representation || 'reference'),
    content,
    reason: {
      code: reasonCode,
      findingIds: [...new Set((candidate?.reason?.findingIds ?? []).map(String))].sort()
    },
    source: {
      type: text(candidate?.source?.type || 'unavailable'),
      reference: candidate?.source?.reference == null ? null : text(candidate.source.reference),
      sha256: candidate?.source?.sha256 ?? null,
      derivationKey: candidate?.source?.derivationKey ? structuredClone(candidate.source.derivationKey) : null
    },
    relationship: text(candidate?.relationship || ''),
    bytes: Buffer.byteLength(content),
    sourceMaterial: candidate?.sourceMaterial === true,
    mandatory: candidate?.mandatory === true,
    cacheClass: ['stable', 'session-stable', 'variable'].includes(candidate?.cacheClass)
      ? candidate.cacheClass : 'variable',
    expansion: candidate?.expansion ? structuredClone(candidate.expansion) : null
  };
  return {
    itemId: `ctx-item-${recordSha256(candidateIdentity(normalized)).slice(0, 20)}`,
    ...normalized
  };
}

export function compareContextCandidates(leftValue, rightValue) {
  const left = normalizeContextCandidate(leftValue);
  const right = normalizeContextCandidate(rightValue);
  return Number(right.mandatory) - Number(left.mandatory)
    || (CONTEXT_REASON_PRIORITY[left.reason.code] - CONTEXT_REASON_PRIORITY[right.reason.code])
    || (CLASSIFICATION_ORDER[left.classification] - CLASSIFICATION_ORDER[right.classification])
    || left.relationship.localeCompare(right.relationship)
    || left.subject.localeCompare(right.subject)
    || text(left.source.reference).localeCompare(text(right.source.reference))
    || left.itemId.localeCompare(right.itemId);
}

export function rankContextCandidates(candidates = []) {
  const deduplicated = new Map();
  for (const value of candidates) {
    const candidate = normalizeContextCandidate(value);
    if (!deduplicated.has(candidate.itemId)) deduplicated.set(candidate.itemId, candidate);
  }
  return [...deduplicated.values()].sort(compareContextCandidates);
}

/** Select in priority order while allowing a smaller later item to use otherwise stranded bytes. */
export function selectContextCandidates(candidates, maximumContentBytes) {
  const ranked = rankContextCandidates(candidates);
  const mandatory = ranked.filter((candidate) => candidate.mandatory);
  const requiredBytes = mandatory.reduce((total, candidate) => total + candidate.bytes, 0);
  if (requiredBytes > maximumContentBytes) {
    const byClass = Object.fromEntries([...new Set(mandatory.map((candidate) => candidate.kind))].sort()
      .map((kind) => [kind, mandatory.filter((candidate) => candidate.kind === kind)
        .reduce((total, candidate) => total + candidate.bytes, 0)]));
    throw new SingularityFlowError(
      `Mandatory governance context requires ${requiredBytes} bytes but the context-content limit is ${maximumContentBytes} bytes.`,
      {
        code: 'TKN_MANDATORY_CONTEXT_OVERFLOW',
        details: {
          requiredBytes, configuredLimitBytes: maximumContentBytes, byClass,
          unsafeReason: 'Applicable governance context cannot be truncated or budget-evicted.',
          nextAction: 'Select an approved larger token-economy profile, narrow the operation, or split the work.'
        }
      }
    );
  }
  const items = [];
  const omissions = [];
  let includedContentBytes = 0;
  for (const candidate of ranked) {
    if (candidate.bytes <= maximumContentBytes - includedContentBytes) {
      items.push(candidate);
      includedContentBytes += candidate.bytes;
    } else {
      omissions.push({ ...candidate, omissionReason: 'budget' });
    }
  }
  return { items, omissions, includedContentBytes, ranked };
}
