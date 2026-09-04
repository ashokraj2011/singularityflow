/**
 * GDP-M2 shadow Proof Subject and Change Passport.
 *
 * This is an opt-in diagnostic projection over an already-verified M1 compatibility view. It is
 * deliberately pure: no filesystem, Git, lifecycle, model, AST, World Model, clock, or random
 * source is reachable from this module. The records are returned in memory and grant no authority.
 */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROFILES = new Set(['standard', 'high-assurance', 'regulated', 'custom-registered']);
const MAX_REFS = 256;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

function fail(message) {
  throw new TypeError(`GDP shadow Passport: ${message}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(value) {
  return `sha256:${recordSha256(value)}`;
}

function requireDigest(value, label) {
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}

function refs(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`);
  const result = [...new Set(values.map((value) => requireDigest(value, label)))].sort();
  if (result.length > MAX_REFS) fail(`${label} exceeds ${MAX_REFS} entries.`);
  return result;
}

function shadowPolicy(role, sourcePolicySha256) {
  return digest({ schemaVersion: 1, kind: 'gdp-shadow-policy-binding', role, sourcePolicySha256 });
}

function worldModelBinding(compatibility) {
  const available = compatibility.worldModel?.status === 'legacy'
    && DIGEST.test(String(compatibility.worldModel?.sha256 ?? ''));
  return available ? {
    status: 'ready',
    baselineSha256: compatibility.worldModel.sha256,
    candidateDeltaSha256: null,
    reasonCode: null
  } : {
    status: 'unavailable',
    baselineSha256: null,
    candidateDeltaSha256: null,
    reasonCode: 'GDP_WORLD_MODEL_UNAVAILABLE'
  };
}

function passportStatus(compatibility) {
  if (compatibility.publication?.status === 'pending') return 'publication-pending';
  if (compatibility.lifecycle?.requiresRecovery) return 'recovery-required';
  if (compatibility.publication?.status === 'published') return 'published';
  if (compatibility.lifecycle?.normalizedStatus === 'cancelled') return 'cancelled';
  if (compatibility.lifecycle?.normalizedStatus === 'failed') return 'rejected';
  return 'candidate-ready';
}

function comparisonCategory(compatibility, status, candidateAvailable) {
  if (!candidateAvailable) return 'candidate-unavailable';
  if (compatibility.lifecycle?.normalizedStatus === 'unavailable') return 'lifecycle-unavailable';
  if (compatibility.publication?.status === 'pending') {
    return status === 'publication-pending' ? 'aligned' : 'publication-state-diverged';
  }
  if (compatibility.lifecycle?.requiresRecovery && status !== 'recovery-required') {
    return 'recovery-state-diverged';
  }
  return 'aligned';
}

/**
 * Derive one path-free, bounded shadow diagnostic. `sourcePolicySha256` is the exact digest of the
 * legacy policy source; where an old record has no distinct policy record, callers may use the M1
 * projection digest and the result remains explicitly labelled `legacy-projection`.
 */
export function buildShadowChangePassport({
  compatibility,
  sourcePolicySha256 = compatibility?.projectionSha256,
  sourceRecordSha256 = compatibility?.projectionSha256,
  proofProfile = 'standard',
  decisionRefs = [],
  publicationRefs = []
} = {}) {
  if (!compatibility || compatibility.kind !== 'gdp-compatibility-projection') {
    fail('compatibility must be a verified GDP M1 compatibility projection.');
  }
  if (!PROFILES.has(proofProfile)) fail(`unsupported proof profile '${proofProfile}'.`);
  const policySource = requireDigest(sourcePolicySha256, 'sourcePolicySha256');
  const recordSource = requireDigest(sourceRecordSha256, 'sourceRecordSha256');
  const candidateSha256 = DIGEST.test(String(compatibility.candidate?.sha256 ?? ''))
    ? compatibility.candidate.sha256 : null;
  const subject = {
    kind: compatibility.subject?.kind,
    id: String(compatibility.subject?.id ?? '')
  };
  if (!['story', 'outcome', 'initiative'].includes(subject.kind)
      || !subject.id || subject.id.length > 160) fail('compatibility subject is invalid.');

  const policyBindings = {
    completionContractSha256: shadowPolicy('completion-contract', policySource),
    effectPolicySha256: shadowPolicy('effect-policy', policySource),
    proofPolicySha256: shadowPolicy('proof-policy', policySource)
  };
  const selectionSha256 = digest({
    schemaVersion: 1,
    kind: 'gdp-shadow-delivery-selection',
    subject,
    delivery: compatibility.delivery,
    proofProfile,
    sourcePolicySha256: policySource
  });
  const worldModel = worldModelBinding(compatibility);
  const gaps = [
    {
      code: 'GDP_SHADOW_POLICY_PROJECTION',
      status: 'legacy',
      message: 'Completion, effect, proof, and selection identities are shadow projections, not ratified GDP authority.'
    },
    {
      code: 'GDP_PROOF_SUMMARY_UNAVAILABLE',
      status: 'unavailable',
      message: 'GDP-M2 does not evaluate proof predicates or create a Proof Summary.'
    }
  ];
  if (worldModel.status === 'unavailable') gaps.push({
    code: 'GDP_WORLD_MODEL_UNAVAILABLE',
    status: 'unavailable',
    message: 'No reusable World Model identity was available; the shadow view remains diagnostic and non-blocking.'
  });
  if (!candidateSha256) gaps.push({
    code: 'GDP_CANDIDATE_UNAVAILABLE',
    status: 'unavailable',
    message: 'The legacy runtime has not produced an exact Candidate, so no Proof Subject or Passport can be derived.'
  });

  let records = null;
  let status = 'unavailable';
  if (candidateSha256) {
    const proofCore = {
      schemaVersion: currentSchemaVersion('proof-subject'),
      kind: 'proof-subject',
      workId: subject.id,
      candidateSha256,
      ...policyBindings,
      proofProfile,
      worldModel
    };
    const proofSubject = {
      ...proofCore,
      proofSubjectSha256: digest(proofCore)
    };
    status = passportStatus(compatibility);
    const passportId = `GDP-SHADOW-${recordSha256({ subject, candidateSha256 }).slice(0, 24).toUpperCase()}`;
    const passportCore = {
      schemaVersion: currentSchemaVersion('change-passport'),
      kind: 'change-passport',
      passportId,
      revision: 1,
      priorPassportSha256: null,
      subject,
      selectionSha256,
      candidateSha256,
      proofSubjectSha256: proofSubject.proofSubjectSha256,
      proofSummarySha256: null,
      decisionRefs: refs(decisionRefs, 'decisionRefs'),
      publicationRefs: refs(publicationRefs, 'publicationRefs'),
      status
    };
    records = {
      proofSubject,
      passport: { ...passportCore, passportSha256: digest(passportCore) }
    };
  }

  const core = {
    schemaVersion: 1,
    kind: 'gdp-shadow-passport-diagnostic',
    mode: 'shadow',
    authority: 'none',
    status,
    subject,
    candidate: {
      status: candidateSha256 ? 'legacy' : 'unavailable',
      candidateSha256,
      assurance: compatibility.candidate?.assurance ?? 'unavailable'
    },
    policies: {
      status: 'legacy-projection',
      sourcePolicySha256: policySource,
      selectionSha256,
      ...policyBindings,
      proofProfile: { value: proofProfile, status: 'shadow-default-not-authority' }
    },
    evidence: {
      status: 'legacy',
      proofSummarySha256: null,
      decisionRefs: records?.passport.decisionRefs ?? refs(decisionRefs, 'decisionRefs'),
      publicationRefs: records?.passport.publicationRefs ?? refs(publicationRefs, 'publicationRefs')
    },
    worldModel,
    gaps,
    provenance: {
      sourceKind: compatibility.sourceKind,
      sourceRecordSha256: recordSource,
      compatibilityProjectionSha256: requireDigest(compatibility.projectionSha256, 'compatibility.projectionSha256'),
      checkoutPathIncluded: false,
      generatedBy: 'gdp-m2-shadow-v1'
    },
    comparison: {
      legacyLifecycleStatus: compatibility.lifecycle?.normalizedStatus ?? 'unavailable',
      legacyPublicationStatus: compatibility.publication?.status ?? 'unavailable',
      shadowStatus: status,
      category: comparisonCategory(compatibility, status, Boolean(candidateSha256)),
      explained: true
    },
    records,
    guarantees: {
      projectionOnly: true,
      sourceRemainsAuthority: true,
      consumedByLifecycle: false,
      noWrites: true,
      noModel: true,
      astRequired: false,
      worldModelRequired: false
    }
  };
  const result = { ...core, diagnosticSha256: digest(core) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DIAGNOSTIC_BYTES) {
    fail(`diagnostic exceeds ${MAX_DIAGNOSTIC_BYTES} bytes.`);
  }
  return deepFreeze(result);
}

/** Privacy-safe aggregate: no question, path, work ID, identity, Candidate, or Passport is kept. */
export function summarizeShadowComparisons(diagnostics = []) {
  if (!Array.isArray(diagnostics)) fail('diagnostics must be an array.');
  const categories = {};
  for (const diagnostic of diagnostics) {
    const category = String(diagnostic?.comparison?.category ?? 'unavailable');
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(category)) fail('comparison category is invalid.');
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'gdp-shadow-comparison-summary',
    total: diagnostics.length,
    categories: Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)))
  });
}
