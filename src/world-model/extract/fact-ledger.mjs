import { canonicalJson, collisionSafeIds, compareText, sealRecord, sha256 } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  DERIVATION_ID_PATTERN, EVIDENCE_ID_PATTERN, FACT_ID_PATTERN, assertCanonicalOrder,
  assertExactKeys, assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256,
  assertString, assertStringArray, contractFailure
} from '../contracts.mjs';
import { validateExtractorRegistry } from '../registry/extractors.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { assertSubjectAllowed } from '../scope/validate.mjs';
import { validateSourceSnapshot } from '../source/snapshot.mjs';
import {
  ASSURANCE_LEVELS, FACT_STATUSES, FACT_TYPES, SUBJECT_KINDS, UNAVAILABLE_REASON_CODES,
  assertVocabularyValue
} from '../vocabularies.mjs';
import { validateEvidenceCatalog } from './evidence-catalog.mjs';

function exactSubject(value) {
  assertExactKeys(value, { required: ['kind', 'id'], label: 'Fact subject' });
  assertVocabularyValue('Fact subject kind', value.kind, SUBJECT_KINDS);
  assertString(value.id, 'Fact subject id');
  return value;
}

export function factIdentityFromRecord(value) {
  const identity = {
    factType: value.factType,
    subject: structuredClone(value.subject),
    claim: value.claim,
    status: value.status,
    assurance: value.assurance,
    evidenceIds: [...value.evidenceIds],
    derivationId: value.derivationId,
    conflictsWith: [...value.conflictsWith],
    scopeStatus: value.scopeStatus
  };
  if (Object.hasOwn(value, 'reason')) identity.reason = structuredClone(value.reason);
  return identity;
}

export function factIdentitySha256(value) {
  return sha256(factIdentityFromRecord(value));
}

function validateReason(value) {
  assertExactKeys(value, { required: ['code', 'detail', 'attemptedProducer'], label: 'Unavailable fact reason' });
  assertVocabularyValue('Unavailable fact reason code', value.code, UNAVAILABLE_REASON_CODES);
  assertString(value.detail, 'Unavailable fact reason detail');
  assertString(value.attemptedProducer, 'Unavailable fact attemptedProducer');
  return value;
}

export function validateFactRecord(value, { evidenceIds = null, derivationIds = null, factIds = null,
  expectedId = null } = {}) {
  assertPlainRecord(value, 'Fact Ledger record');
  assertExactKeys(value, {
    required: [
      'id', 'factType', 'subject', 'claim', 'claimSha256', 'status', 'assurance',
      'evidenceIds', 'derivationId', 'conflictsWith', 'scopeStatus', 'factSha256'
    ],
    optional: ['reason'],
    label: 'Fact Ledger record'
  });
  assertString(value.id, 'Fact id', { pattern: FACT_ID_PATTERN });
  assertVocabularyValue('Fact type', value.factType, FACT_TYPES);
  exactSubject(value.subject);
  assertVocabularyValue('Fact status', value.status, FACT_STATUSES);
  assertVocabularyValue('Fact assurance', value.assurance, ASSURANCE_LEVELS);
  assertStringArray(value.evidenceIds, 'Fact evidenceIds', { sorted: true, pattern: EVIDENCE_ID_PATTERN });
  assertString(value.derivationId, 'Fact derivationId', { pattern: DERIVATION_ID_PATTERN });
  assertStringArray(value.conflictsWith, 'Fact conflictsWith', { sorted: true, pattern: FACT_ID_PATTERN });
  if (value.scopeStatus !== 'inside') contractFailure("Registered Fact scopeStatus must be 'inside'.", 'WMB_FACT_OUT_OF_SCOPE');

  if (value.status === 'unavailable') {
    if (value.claim !== null) contractFailure('Unavailable Fact claim must be null.');
    if (value.assurance !== 'not-applicable') contractFailure("Unavailable Fact assurance must be 'not-applicable'.");
    if (!Object.hasOwn(value, 'reason')) contractFailure('Unavailable Fact must carry a typed reason.');
    validateReason(value.reason);
    if (value.conflictsWith.length) contractFailure('Unavailable Fact cannot carry contradiction references.');
  } else {
    assertString(value.claim, 'Fact claim');
    if (value.assurance === 'not-applicable') contractFailure("Only an unavailable Fact may use 'not-applicable' assurance.");
    if (Object.hasOwn(value, 'reason')) contractFailure('Only an unavailable Fact may carry a reason.');
    if (!value.evidenceIds.length) contractFailure('A current non-unavailable Fact requires registered evidence.');
    if (value.status === 'contradicted' && !value.conflictsWith.length) contractFailure('A contradicted Fact must identify conflicting Facts.');
    if (value.status !== 'contradicted' && value.conflictsWith.length) contractFailure('Only a contradicted Fact may carry conflict references.');
  }
  const expectedClaim = sha256(value.claim);
  assertSha256(value.claimSha256, 'Fact claimSha256');
  if (value.claimSha256 !== expectedClaim) contractFailure(`Fact '${value.id}' claimSha256 does not match its claim.`, 'WMB_RECORD_HASH_MISMATCH');
  if (evidenceIds) for (const id of value.evidenceIds) {
    if (!evidenceIds.has(id)) contractFailure(`Fact '${value.id}' references unknown evidence '${id}'.`, 'WMB_EVIDENCE_NOT_REGISTERED');
  }
  if (derivationIds && !derivationIds.has(value.derivationId)) {
    contractFailure(`Fact '${value.id}' references unknown derivation '${value.derivationId}'.`, 'WMB_DERIVATION_NOT_REGISTERED');
  }
  if (factIds) for (const id of value.conflictsWith) {
    if (!factIds.has(id)) contractFailure(`Fact '${value.id}' references unknown conflicting Fact '${id}'.`, 'WMB_FACT_NOT_REGISTERED');
  }
  if (value.conflictsWith.includes(value.id)) contractFailure(`Fact '${value.id}' cannot conflict with itself.`);
  const identityDigest = factIdentitySha256(value).slice(7);
  if (!value.id.slice(5).startsWith(identityDigest.slice(0, value.id.length - 5))) {
    contractFailure(`Fact '${value.id}' is not content-addressed to its identity.`, 'WMB_CONTENT_ID_INVALID');
  }
  if (expectedId && value.id !== expectedId) contractFailure(`Fact '${value.id}' is not the canonical collision-safe ID.`, 'WMB_CONTENT_ID_INVALID');
  assertSha256(value.factSha256, 'Fact factSha256');
  assertSelfHash(value, 'factSha256', 'Fact Ledger record');
  return value;
}

export function unavailableFactDraft({ factType, subject, derivationId, code, detail, attemptedProducer,
  evidenceIds = [] }) {
  return {
    factType,
    subject,
    claim: null,
    status: 'unavailable',
    assurance: 'not-applicable',
    evidenceIds,
    derivationId,
    conflictsWith: [],
    scopeStatus: 'inside',
    reason: { code, detail, attemptedProducer }
  };
}

function normalizeDraft(value) {
  assertPlainRecord(value, 'Fact draft');
  assertExactKeys(value, {
    required: [
      'factType', 'subject', 'claim', 'status', 'assurance', 'evidenceIds',
      'derivationId', 'conflictsWith', 'scopeStatus'
    ],
    optional: ['reason'],
    label: 'Fact draft'
  });
  const normalized = structuredClone(value);
  normalized.evidenceIds = [...new Set(normalized.evidenceIds)].sort();
  normalized.conflictsWith = [...new Set(normalized.conflictsWith)].sort();
  const provisional = sealRecord({
    id: `FACT-${factIdentitySha256({ ...normalized, evidenceIds: normalized.evidenceIds, conflictsWith: normalized.conflictsWith }).slice(7, 23)}`,
    ...normalized,
    claimSha256: sha256(normalized.claim)
  }, 'factSha256');
  validateFactRecord(provisional);
  return normalized;
}

export function createFactLedger({ sourceSnapshot, scopeManifest, extractorRegistry, evidenceCatalog,
  derivationIds = null, factDrafts = [] } = {}) {
  const source = validateSourceSnapshot(sourceSnapshot);
  const scope = validateScopeManifest(scopeManifest);
  const registry = validateExtractorRegistry(extractorRegistry);
  const evidence = validateEvidenceCatalog(evidenceCatalog, { sourceSnapshot: source, scopeManifest: scope });
  if (!Array.isArray(factDrafts)) contractFailure('Fact drafts must be an array.');
  const unique = new Map();
  for (const draftValue of factDrafts) {
    const draft = normalizeDraft(draftValue);
    assertSubjectAllowed(draft.subject.kind, scope);
    const digest = sha256(draft);
    const canonical = canonicalJson(draft);
    if (unique.has(digest) && unique.get(digest).canonical !== canonical) {
      contractFailure('Distinct Fact identities produced the same full SHA-256 digest.', 'WMB_CONTENT_DIGEST_COLLISION');
    }
    unique.set(digest, { draft, canonical });
  }
  const ids = collisionSafeIds([...unique.keys()], { prefix: 'FACT-' });
  const facts = [...unique.entries()].map(([digest, { draft }]) => sealRecord({
    id: ids.get(digest.slice(7)),
    ...draft,
    claimSha256: sha256(draft.claim)
  }, 'factSha256')).sort((left, right) => compareText(left.id, right.id));
  return validateFactLedger(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-fact-ledger'),
    kind: 'world-model-fact-ledger',
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    extractorRegistrySha256: registry.registrySha256,
    facts
  }, 'ledgerSha256'), {
    sourceSnapshot: source, scopeManifest: scope, extractorRegistry: registry,
    evidenceCatalog: evidence, derivationIds
  });
}

export function validateFactLedger(value, { sourceSnapshot = null, scopeManifest = null,
  extractorRegistry = null, evidenceCatalog = null, derivationIds = null } = {}) {
  assertPlainRecord(value, 'World-model Fact Ledger');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'sourceManifestSha256', 'scopeManifestSha256',
      'extractorRegistrySha256', 'facts', 'ledgerSha256'
    ],
    label: 'World-model Fact Ledger'
  });
  assertSchemaKind(value, 'world-model-fact-ledger', 'World-model Fact Ledger');
  for (const field of ['sourceManifestSha256', 'scopeManifestSha256', 'extractorRegistrySha256']) {
    assertSha256(value[field], `Fact Ledger ${field}`);
  }
  if (sourceSnapshot && validateSourceSnapshot(sourceSnapshot).sourceManifestSha256 !== value.sourceManifestSha256) {
    contractFailure('Fact Ledger source binding is invalid.', 'WMB_FACT_SOURCE_MISMATCH');
  }
  if (scopeManifest && validateScopeManifest(scopeManifest).scopeSha256 !== value.scopeManifestSha256) {
    contractFailure('Fact Ledger scope binding is invalid.', 'WMB_FACT_OUT_OF_SCOPE');
  }
  if (extractorRegistry && validateExtractorRegistry(extractorRegistry).registrySha256 !== value.extractorRegistrySha256) {
    contractFailure('Fact Ledger extractor registry binding is invalid.', 'WMB_EXTRACTOR_REGISTRY_MISMATCH');
  }
  const evidence = evidenceCatalog ? validateEvidenceCatalog(evidenceCatalog) : null;
  if (evidence && (evidence.sourceManifestSha256 !== value.sourceManifestSha256
      || evidence.scopeManifestSha256 !== value.scopeManifestSha256)) {
    contractFailure('Fact Ledger and Evidence Catalog source/scope bindings disagree.', 'WMB_FACT_SOURCE_MISMATCH');
  }
  const evidenceIds = evidence ? new Set(evidence.items.map((item) => item.id)) : null;
  const evidenceById = evidence ? new Map(evidence.items.map((item) => [item.id, item])) : null;
  if (!Array.isArray(value.facts)) contractFailure('Fact Ledger facts must be an array.');
  const digests = value.facts.map(factIdentitySha256);
  if (new Set(digests).size !== digests.length) contractFailure('Fact Ledger contains duplicate Fact identities.');
  const allocated = collisionSafeIds(digests, { prefix: 'FACT-' });
  const factIds = new Set(value.facts.map((fact) => fact.id));
  value.facts.forEach((fact) => {
    validateFactRecord(fact, {
      evidenceIds, derivationIds, factIds, expectedId: allocated.get(factIdentitySha256(fact).slice(7))
    });
    if (evidenceById) {
      const expectedSubjectSha256 = sha256(fact.subject);
      for (const evidenceId of fact.evidenceIds) {
        if (evidenceById.get(evidenceId)?.subjectSha256 !== expectedSubjectSha256) {
          contractFailure(
            `Fact '${fact.id}' evidence '${evidenceId}' is bound to a different subject.`,
            'WMB_EVIDENCE_SUBJECT_MISMATCH',
            { factId: fact.id, evidenceId, expectedSubjectSha256 }
          );
        }
      }
    }
    if (scopeManifest) assertSubjectAllowed(fact.subject.kind, scopeManifest);
  });
  if (factIds.size !== value.facts.length) contractFailure('Fact Ledger repeats a Fact id.');
  assertCanonicalOrder(value.facts, (fact) => fact.id, 'Fact Ledger facts');
  assertSha256(value.ledgerSha256, 'Fact Ledger ledgerSha256');
  assertSelfHash(value, 'ledgerSha256', 'World-model Fact Ledger');
  return value;
}
